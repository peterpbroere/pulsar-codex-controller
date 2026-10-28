import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'python'))
from hook_setup import merge_hooks, install_hooks
from pulsar_paths import default_store


class HookSetupTests(unittest.TestCase):
    def test_install_preserves_other_hooks_and_is_idempotent(self):
        existing={'custom':'preserve','hooks':{'Stop':[{'matcher':'*','hooks':[{'type':'command','command':'other-tool'}]}]}}
        once=merge_hooks(existing,'PulsarBackend.exe hook')
        self.assertEqual(once['custom'],'preserve')
        self.assertEqual(once['hooks']['Stop'][0],existing['hooks']['Stop'][0])
        self.assertEqual(once,merge_hooks(once,'PulsarBackend.exe hook'))
        self.assertEqual(existing['hooks']['Stop'][0]['hooks'][0]['command'],'other-tool')

    def test_uninstall_removes_only_pulsar_entries(self):
        existing={'hooks':{'Stop':[{'hooks':[{'command':'other-tool'},{'command':'PulsarBackend.exe hook'}]}]}}
        result=merge_hooks(existing,'PulsarBackend.exe hook',remove=True)
        self.assertEqual(result,{'hooks':{'Stop':[{'hooks':[{'command':'other-tool'}]}]}})

    def test_preview_does_not_write_and_apply_backs_up_exact_original(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'hooks.json'; original='{"hooks": {}, "keep": 42}\n';path.write_text(original)
            with patch('hook_setup.hook_command',return_value='PulsarBackend.exe hook'):
                self.assertTrue(install_hooks(path)['changed']);self.assertEqual(path.read_text(),original)
                result=install_hooks(path,apply=True)
            self.assertEqual(Path(result['backup']).read_text(),original)
            self.assertEqual(json.loads(path.read_text())['keep'],42)

    def test_invalid_config_remains_untouched(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'hooks.json';path.write_text('{"hooks": []}')
            with self.assertRaises(ValueError):install_hooks(path,apply=True)
            self.assertEqual(path.read_text(),'{"hooks": []}')

    def test_packaged_hook_path_survives_application_update(self):
        existing={'hooks':{'Stop':[{'hooks':[{'command':'"C:\\old\\PulsarBackend.exe" hook'}]}]}}
        result=merge_hooks(existing,'"C:\\new\\PulsarBackend.exe" hook')
        self.assertEqual(len(result['hooks']['Stop']),1)

    def test_standalone_store_does_not_require_flipper_checkout(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.dict(os.environ,{'LOCALAPPDATA':folder},clear=True):
                self.assertEqual(default_store(),Path(folder)/'PulsarCodexDeck/events.sqlite3')
                shared=Path(folder)/'FlipperAgentDeck/events.sqlite3';shared.parent.mkdir();shared.touch()
                self.assertEqual(default_store(),shared)


if __name__=='__main__':unittest.main()
