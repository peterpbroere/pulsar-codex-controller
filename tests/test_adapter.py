import sys
from pathlib import Path
import unittest
from unittest.mock import Mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from adapter import Adapter, MODES, fingerprint


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


if __name__ == '__main__':
    unittest.main()
