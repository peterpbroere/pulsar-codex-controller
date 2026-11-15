"""Ghost-row pruning against the shared Codex server's loaded threads."""
import sys
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
import adapter as adapter_module
from adapter import Adapter


class LoadedPruneTests(unittest.TestCase):
    """A shared app-server outlives sessions, so closed sessions must be
    pruned against thread/loaded/list instead of owner liveness."""

    def make_adapter(self):
        a = Adapter.__new__(Adapter)
        a.deck = Mock()
        a.deck.agents = {}
        a.reader = Mock()
        a.controls = Mock()
        a.controls.contexts = {}
        a.controls.last_loaded = set()
        a.controls.loaded_at = 0.0
        a.focus = Mock()
        a.settings = {}
        a.settings_errors = {}
        a.models, a.models_error, a.models_at = [], "", 0
        a.voices, a.voices_error, a.voices_at, a.voices_rpc = [], "", 0, None
        a.titles, a.titles_at, a.titles_rpc = {}, {}, None
        a.titles = {}
        a.cursor = 0
        a.settings_at = 0.0
        a.reader.read.return_value = []
        a.controls.connected = True
        a.controls.sync = Mock()
        a.controls.decorate = Mock()
        a.read_titles = Mock()
        a.read_models = Mock()
        a.read_voices = Mock()
        a.read_settings = Mock()
        return a

    def row(self, session_id, owner_kind='shared'):
        return dict(id='agent', session_id=session_id, label='L', actions=[],
                    owner_pid=1, owner_created=1.0, owner_kind=owner_kind,
                    pending={}, event='-')

    def test_closed_shared_session_is_pruned_against_loaded_threads(self):
        a = self.make_adapter()
        a.deck.view.return_value = [self.row('live-thread'), self.row('dead-thread')]
        a.controls.last_loaded = {'live-thread'}
        a.controls.loaded_at = adapter_module.time.monotonic()
        snapshot = a.refresh()
        ids = {r['session_id'] for r in snapshot['rows']}
        self.assertIn('live-thread', ids)
        self.assertNotIn('dead-thread', ids)

    def test_session_kind_rows_are_never_pruned_by_loaded_list(self):
        # Dedicated-session owners are already checked with liveness; a thread
        # missing from the shared list says nothing about them.
        a = self.make_adapter()
        a.deck.view.return_value = [self.row('own-thread', owner_kind='session')]
        a.controls.last_loaded = set()
        a.controls.loaded_at = adapter_module.time.monotonic()
        ids = {r['session_id'] for r in a.refresh()['rows']}
        self.assertIn('own-thread', ids)

    def test_stale_loaded_list_never_hides_rows(self):
        # With Codex offline the list goes stale; pruning then would hide
        # every row, so it must be skipped entirely.
        a = self.make_adapter()
        a.deck.view.return_value = [self.row('live-thread')]
        a.controls.last_loaded = set()
        a.controls.loaded_at = adapter_module.time.monotonic() - 10_000
        ids = {r['session_id'] for r in a.refresh()['rows']}
        self.assertIn('live-thread', ids)

    def test_no_loaded_knowledge_keeps_everything(self):
        a = self.make_adapter()
        a.deck.view.return_value = [self.row('any-thread')]
        a.controls.last_loaded = set()
        a.controls.loaded_at = 0.0
        ids = {r['session_id'] for r in a.refresh()['rows']}
        self.assertIn('any-thread', ids)


if __name__ == '__main__':
    unittest.main()
