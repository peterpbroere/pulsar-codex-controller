import importlib.util
import pathlib
import sys
import types
import unittest
from unittest.mock import patch


class ProgressHelperTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        routes = types.SimpleNamespace(get=lambda _path: lambda fn: fn)
        server = types.SimpleNamespace(PromptServer=types.SimpleNamespace(instance=types.SimpleNamespace(routes=routes, send_sync=lambda *args: None)))
        aiohttp = types.SimpleNamespace(web=types.SimpleNamespace())
        path = pathlib.Path(__file__).resolve().parents[1] / 'comfyui/pulsar_deck/__init__.py'
        spec = importlib.util.spec_from_file_location('pulsar_helper', path)
        cls.helper = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {'server': server, 'aiohttp': aiohttp}):
            spec.loader.exec_module(cls.helper)

    def server(self, running=True):
        prompt = {'7': {'class_type': 'KSampler', '_meta': {'title': 'Sampling'}}}
        queue = [[1, 'job', prompt, {}]] if running else []
        return types.SimpleNamespace(prompt_queue=types.SimpleNamespace(get_current_queue=lambda: (queue, [])), last_node_id='7')

    def test_reads_active_progress_without_mutating_registry_or_queue(self):
        state = {'state': types.SimpleNamespace(value='running'), 'value': 18, 'max': 30}
        registry = types.SimpleNamespace(prompt_id='job', nodes={'7': state})
        result = self.helper.progress_snapshot(self.server(), registry)
        self.assertEqual(result, {'version': 1, 'prompt_id': 'job', 'node': 'Sampling', 'value': 18, 'max': 30, 'total': None})
        self.assertIs(registry.nodes['7'], state)

    def test_mismatched_old_job_does_not_leak_steps_into_new_job(self):
        registry = types.SimpleNamespace(prompt_id='previous', nodes={'7': {'state': 'running', 'value': 30, 'max': 30}})
        result = self.helper.progress_snapshot(self.server(), registry)
        self.assertIsNone(result['value'])
        self.assertEqual(result['node'], 'Sampling')

    def test_idle_does_not_report_previous_node(self):
        self.assertEqual(self.helper.progress_snapshot(self.server(False))['node'], '')

    def test_older_versions_without_progress_registry_still_show_current_node(self):
        result = self.helper.progress_snapshot(self.server())
        self.assertEqual(result['node'], 'Sampling')
        self.assertIsNone(result['max'])

    def test_total_matches_cached_and_executed_nodes_without_counting_duplicates(self):
        events = self.helper.ProgressEvents()
        events.record('execution_start', {'prompt_id': 'job'})
        events.record('execution_cached', {'prompt_id': 'job', 'nodes': ['1', '2']})
        events.record('executed', {'prompt_id': 'job', 'node': '2'})
        events.record('executed', {'prompt_id': 'old-job', 'node': '3'})
        result = events.total('job', {'1': {}, '2': {}, '3': {}, '4': {}})
        self.assertEqual(result, {'value': 2, 'max': 4})
        self.assertIsNone(events.total('other-job', {'1': {}}))

    def test_new_job_clears_total_and_dynamic_nodes_join_denominator(self):
        events = self.helper.ProgressEvents()
        events.record('execution_start', {'prompt_id': 'first'})
        events.record('executed', {'prompt_id': 'first', 'node': 'expanded-node'})
        self.assertEqual(events.total('first', {'1': {}, '2': {}}), {'value': 1, 'max': 3})
        events.record('execution_start', {'prompt_id': 'next'})
        self.assertEqual(events.total('next', {'1': {}, '2': {}}), {'value': 0, 'max': 2})

    def test_notification_observer_preserves_arguments_objects_and_return_value(self):
        calls = []
        payload = {'prompt_id': 'job'}
        server = types.SimpleNamespace(send_sync=lambda *args: calls.append(args) or 'original-result')
        events = self.helper.ProgressEvents()
        self.helper.observe_notifications(server, events)
        self.assertEqual(server.send_sync('execution_start', payload, 'browser-client'), 'original-result')
        self.assertIs(calls[0][1], payload)
        self.assertEqual(calls[0], ('execution_start', payload, 'browser-client'))
        self.assertEqual(events.total('job', {'7': {}}), {'value': 0, 'max': 1})
        server.send_sync(1, b'preview', 'browser-client')
        self.assertEqual(calls[-1], (1, b'preview', 'browser-client'))

    def test_snapshot_exposes_total_only_for_the_running_job(self):
        events = self.helper.ProgressEvents()
        events.record('execution_start', {'prompt_id': 'job'})
        self.assertEqual(self.helper.progress_snapshot(self.server(), events=events)['total'], {'value': 0, 'max': 1})
        events.record('execution_start', {'prompt_id': 'other'})
        self.assertIsNone(self.helper.progress_snapshot(self.server(), events=events)['total'])


if __name__ == '__main__':
    unittest.main()
