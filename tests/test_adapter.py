import sys
from pathlib import Path
import unittest
from unittest.mock import Mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from adapter import Adapter, MODES, fingerprint, effective_settings


class AdapterTests(unittest.TestCase):
    def make_adapter(self):
        a = Adapter.__new__(Adapter)
        a.controls = Mock()
        a.focus = Mock()
        a.settings = {}
        a.controls.subscribed = set()
        self.row = dict(id='agent', session_id='session', actions=['approve'], control_token='exact',
                        project='C:/dev', settings_token='settings')
        a.refresh = Mock(return_value={'rows':[self.row]})
        return a

    def test_stale_token_does_not_send_approval(self):
        a = self.make_adapter()
        with self.assertRaises(ValueError):
            a.handle('action', dict(id='agent', session_id='session', verb='approve', token='old'))
        a.controls.execute.assert_not_called()

    def test_exact_token_is_passed_to_existing_controls(self):
        a = self.make_adapter()
        a.handle('action', dict(id='agent', session_id='session', verb='approve', token='exact'))
        a.controls.execute.assert_called_once_with('session', 'approve', 'exact')

    def test_settings_no_prompts_and_full_access_are_distinct(self):
        self.assertEqual(MODES['No prompts']['sandboxPolicy']['type'], 'workspaceWrite')
        self.assertEqual(MODES['YOLO / Full access']['sandboxPolicy']['type'], 'dangerFullAccess')

    def test_settings_changed_between_review_and_apply_is_rejected(self):
        a = self.make_adapter()
        a.read_settings = Mock(return_value={'approvalPolicy':'untrusted'})
        with self.assertRaises(ValueError):
            a.handle('settings', dict(id='agent', session_id='session', mode='Auto', token='settings'))
        a.controls.rpc.request.assert_not_called()

    def test_settings_update_uses_void_response_then_reads_effective_values(self):
        a = self.make_adapter()
        current = {'approvalPolicy':'on-request'}
        a.read_settings = Mock(return_value=current)
        self.row['settings_token'] = fingerprint(current)
        a.handle('settings', dict(id='agent', session_id='session', mode='Read-only', token=fingerprint(current)))
        a.controls.rpc.request.assert_called_once_with('thread/settings/update',
            {'threadId':'session', **MODES['Read-only']})
        self.assertEqual(a.read_settings.call_count, 2)

    def configure_fixture(self, effort='ultra'):
        a = self.make_adapter()
        current = {'model':'model-a','effort':effort,'approvalPolicy':'on-request','sandboxPolicy':{'type':'workspaceWrite'}}
        models = [{'id':'model-a','label':'A','efforts':['low','high','ultra'],'defaultEffort':'low'},
                  {'id':'model-b','label':'B','efforts':['medium','high'],'defaultEffort':'medium'}]
        self.row['settings_token'] = fingerprint(current)
        a.read_models = Mock(return_value=models)
        params = dict(id='agent',session_id='session',kind='model',model='model-b',effort='medium',
                      token=fingerprint(current),catalog_token=fingerprint(models))
        return a, current, models, params

    def test_resume_and_notifications_normalize_actual_effort(self):
        self.assertEqual(effective_settings({'reasoningEffort':'high','sandbox':{'type':'readOnly'}})['effort'],'high')
        self.assertEqual(effective_settings({'effort':'max'})['effort'],'max')
        self.assertEqual(effective_settings({'collaborationMode':{'settings':{'reasoning_effort':'medium'}}})['effort'],'medium')
        self.assertIsNone(effective_settings({})['effort'])

    def test_model_update_sends_reviewed_pair_and_preserves_permission_fields(self):
        a, current, models, params = self.configure_fixture()
        a.read_settings = Mock(side_effect=[current,{**current,'model':'model-b','effort':'medium'}])
        a.handle('configuration',params)
        a.controls.rpc.request.assert_called_once_with('thread/settings/update',{'threadId':'session','model':'model-b','effort':'medium'})

    def test_effort_update_sends_only_effort_and_rereads_effective_values(self):
        a, current, models, params = self.configure_fixture()
        params.update(kind='effort',model='model-a',effort='high')
        a.read_settings = Mock(side_effect=[current,{**current,'effort':'high'}])
        a.handle('configuration',params)
        a.controls.rpc.request.assert_called_once_with('thread/settings/update',{'threadId':'session','effort':'high'})

    def test_combined_model_flow_accepts_any_explicit_supported_effort(self):
        a, current, models, params=self.configure_fixture();params['effort']='high'
        a.read_settings=Mock(side_effect=[current,{**current,'model':'model-b','effort':'high'}])
        a.handle('configuration',params)
        a.controls.rpc.request.assert_called_once_with('thread/settings/update',{'threadId':'session','model':'model-b','effort':'high'})

    def test_stale_settings_and_catalog_cannot_change_model(self):
        for stale in ('token','catalog_token'):
            a, current, models, params = self.configure_fixture()
            params[stale]='stale';a.read_settings=Mock(return_value=current)
            with self.assertRaises(ValueError):a.handle('configuration',params)
            a.controls.rpc.request.assert_not_called()

    def test_unsupported_effort_and_unknown_model_are_rejected(self):
        for changes in ({'kind':'effort','model':'model-b','effort':'ultra'}, {'model':'missing'}, {'effort':'ultra'}):
            a, current, models, params=self.configure_fixture();params.update(changes);a.read_settings=Mock(return_value=current)
            with self.assertRaises(ValueError):a.handle('configuration',params)
            a.controls.rpc.request.assert_not_called()

    def test_catalog_paginates_filters_hidden_models_and_caches(self):
        a=self.make_adapter();a.models=[];a.models_error='';a.models_at=0
        model={'model':'model-a','displayName':'A','supportedReasoningEfforts':[{'reasoningEffort':'high'}],'defaultReasoningEffort':'high'}
        a.controls.rpc.request.side_effect=[{'data':[dict(model,hidden=True)],'nextCursor':'page-two'},{'data':[model],'nextCursor':None}]
        self.assertEqual(a.read_models()[0]['efforts'],['high']);a.read_models();self.assertEqual(a.controls.rpc.request.call_count,2)
        self.assertEqual(a.controls.rpc.request.call_args.args[1]['cursor'],'page-two')

    def test_failed_readback_is_not_reported_as_success(self):
        a, current, models, params=self.configure_fixture();a.read_settings=Mock(side_effect=[current,current])
        with self.assertRaisesRegex(ValueError,'did not confirm'):a.handle('configuration',params)


if __name__ == '__main__':
    unittest.main()
