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
        server = types.SimpleNamespace(PromptServer=types.SimpleNamespace(instance=types.SimpleNamespace(routes=routes)))
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
        self.assertEqual(result, {'version': 1, 'prompt_id': 'job', 'node': 'Sampling', 'value': 18, 'max': 30})
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


if __name__ == '__main__':
    unittest.main()
