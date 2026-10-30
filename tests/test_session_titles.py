import sys
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from adapter import Adapter, label_sessions


def row(session='session', label='project', agent='abcd1234'):
    return {'id': agent, 'session_id': session, 'label': label, 'automatic_name': label,
            'name': '', 'project': 'C:/dev/project', 'control_token': 'exact-request'}


class SessionTitleTests(unittest.TestCase):
    def adapter(self):
        a = Adapter.__new__(Adapter)
        a.controls = Mock(connected=True)
        a.titles, a.titles_at, a.titles_rpc = {}, {}, None
        a.original_message = Mock()
        return a

    def test_read_only_metadata_title_replaces_directory_label_and_is_cached(self):
        a = self.adapter()
        a.controls.rpc.request.return_value = {'thread': {'id': 'session', 'name': 'Fix image previews'}}
        rows = [row()]
        a.read_titles(rows)
        label_sessions(rows, a.titles)
        self.assertEqual(rows[0]['label'], 'Fix image previews')
        self.assertEqual(rows[0]['project'], 'C:/dev/project')
        self.assertEqual(rows[0]['control_token'], 'exact-request')
        a.read_titles(rows)
        a.controls.rpc.request.assert_called_once_with('thread/read', {'threadId': 'session', 'includeTurns': False}, timeout=2)

    def test_untitled_sessions_fall_back_to_existing_name_or_directory(self):
        rows = [row(), row('other', 'another-project', 'efgh1234')]
        rows[1]['name'] = 'Existing custom label'
        label_sessions(rows, {'session': ''})
        self.assertEqual([r['label'] for r in rows], ['project', 'Existing custom label'])

    def test_duplicate_titles_get_distinct_ids_without_affecting_identity(self):
        rows = [row(), row('other', 'project', 'efgh1234')]
        label_sessions(rows, {'session': 'Fix tests', 'other': 'Fix tests'})
        self.assertEqual([r['label'] for r in rows], ['abcd Fix tests', 'efgh Fix tests'])
        self.assertEqual([r['session_id'] for r in rows], ['session', 'other'])

    def test_rename_notification_updates_title_and_clearing_it_restores_fallback(self):
        a = self.adapter()
        notification = {'method': 'thread/name/updated', 'params': {'threadId': 'session', 'threadName': '  New\n title  '}}
        a.message(notification)
        rows = [row()]
        label_sessions(rows, a.titles)
        self.assertEqual(rows[0]['label'], 'New title')
        a.original_message.assert_called_once_with(notification)
        a.message({'method': 'thread/name/updated', 'params': {'threadId': 'session', 'threadName': None}})
        label_sessions(rows, a.titles)
        self.assertEqual(rows[0]['label'], 'project')

    def test_metadata_failure_retains_known_title_and_missing_metadata_uses_fallback(self):
        a = self.adapter()
        a.titles = {'session': 'Known title'}
        a.controls.rpc.request.side_effect = RuntimeError('Temporarily unavailable')
        rows = [row(), row('other', 'fallback', 'efgh1234')]
        a.read_titles(rows)
        label_sessions(rows, a.titles)
        self.assertEqual([r['label'] for r in rows], ['Known title', 'fallback'])

    def test_removed_sessions_are_pruned_and_reconnection_refreshes_titles(self):
        a = self.adapter()
        a.titles, a.titles_at = {'gone': 'Old'}, {'gone': 999999, 'unavailable': 999999}
        a.controls.rpc.request.return_value = {'thread': {'id': 'session', 'name': 'First'}}
        a.read_titles([row()])
        self.assertNotIn('gone', a.titles)
        self.assertNotIn('unavailable', a.titles_at)
        a.controls.rpc = Mock()
        a.controls.rpc.request.return_value = {'thread': {'id': 'session', 'name': 'After reconnect'}}
        a.read_titles([row()])
        self.assertEqual(a.titles['session'], 'After reconnect')

    def test_wrong_thread_response_cannot_relabel_an_agent(self):
        a = self.adapter()
        a.controls.rpc.request.return_value = {'thread': {'id': 'other', 'name': 'Wrong title'}}
        rows = [row()]
        a.read_titles(rows)
        label_sessions(rows, a.titles)
        self.assertEqual(rows[0]['label'], 'project')

    def test_live_rename_during_metadata_read_wins_over_older_response(self):
        a = self.adapter()
        def response(*args, **kwargs):
            a.message({'method': 'thread/name/updated', 'params': {'threadId': 'session', 'threadName': 'Newest title'}})
            return {'thread': {'id': 'session', 'name': 'Older title'}}
        a.controls.rpc.request.side_effect = response
        a.read_titles([row()])
        self.assertEqual(a.titles['session'], 'Newest title')

    def test_metadata_reads_are_bounded_per_refresh(self):
        a = self.adapter()
        a.controls.rpc.request.return_value = {'thread': {'id': 'missing'}}
        a.read_titles([row(str(i)) for i in range(10)])
        self.assertEqual(a.controls.rpc.request.call_count, 4)


if __name__ == '__main__':
    unittest.main()
