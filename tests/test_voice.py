import sys
from pathlib import Path
import threading
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from adapter import Adapter


class FakeRPC:
    def __init__(self, connected=True):
        self.connected = connected
        self.calls = []
        self.result = {}

    def request(self, method, params, **kwargs):
        self.calls.append((method, params, kwargs))
        return self.result


class FakeControls:
    def __init__(self, rpc, contexts=None):
        self.rpc = rpc
        self.contexts = contexts or {}

    @property
    def connected(self):
        return self.rpc is not None and self.rpc.connected


class VoiceTests(unittest.TestCase):
    def make_adapter(self, rows=None, rpc=None, loaded=True):
        adapter = Adapter.__new__(Adapter)
        adapter.voice_lock = threading.RLock()
        adapter.voice = None
        from collections import deque
        adapter.stopped_voice_ids = deque(maxlen=128)
        adapter.voice_events = []
        adapter.voice_event_writer = adapter.voice_events.append
        adapter.controls = FakeControls(rpc or FakeRPC(), {'thread-1': object()} if loaded else {})
        adapter.refresh = Mock(return_value={'rows': rows if rows is not None else [
            {'id': 'agent-1', 'session_id': 'thread-1'}]})
        adapter.original_message = Mock()
        adapter.titles = {}
        adapter.titles_at = {}
        adapter.settings = {}
        adapter.voices = ['juniper', 'maple']
        adapter.voices_error = ''
        adapter.voices_at = 0
        adapter.voices_rpc = None
        adapter.refresh.return_value.update({'voices': adapter.voices, 'voices_error': ''})
        return adapter

    def start(self, adapter, voice_id='voice-1', **changes):
        params = {'id': 'agent-1', 'session_id': 'thread-1', 'voice_id': voice_id,
                  'sdp': 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'}
        params.update(changes)
        return adapter.handle('voice-start', params)

    def expire_stop_grace(self, adapter):
        voice = adapter.voice
        voice['stop_cleanup_timer'].cancel()
        adapter._finish_voice(voice, 'voice/stopped', {'threadId': voice['thread_id']})

    def test_start_routes_to_selected_thread_using_native_v3_webrtc(self):
        rpc = FakeRPC()
        adapter = self.make_adapter(rpc=rpc)
        self.assertEqual(self.start(adapter), {'voice_id': 'voice-1'})
        self.assertEqual(rpc.calls, [('thread/realtime/start', {
            'threadId': 'thread-1', 'version': 'v3', 'outputModality': 'audio',
            'transport': {'type': 'webrtc', 'sdp': 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'},
            'flushTranscriptTailOnSessionEnd': True, 'voiceSessionId': 'voice-1',
        }, {})])
        self.assertEqual(adapter.voice['thread_id'], 'thread-1')
        self.assertEqual([call[0] for call in rpc.calls], ['thread/realtime/start'])

    def test_start_passes_only_a_supported_selected_voice(self):
        rpc = FakeRPC()
        adapter = self.make_adapter(rpc=rpc)
        self.start(adapter, voice_name='maple')
        start_params = rpc.calls[0][1]
        self.assertEqual(start_params['voice'], 'maple')
        self.assertEqual(start_params['threadId'], 'thread-1')
        self.assertEqual(start_params['transport'], {'type': 'webrtc',
                         'sdp': 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'})
        self.assertEqual(start_params['version'], 'v3')
        self.assertEqual(start_params['outputModality'], 'audio')
        self.assertEqual(start_params['flushTranscriptTailOnSessionEnd'], True)
        self.assertEqual(start_params['voiceSessionId'], 'voice-1')

    def test_default_voice_is_omitted_even_if_catalog_has_error(self):
        for voice_name in (None, ''):
            rpc = FakeRPC()
            adapter = self.make_adapter(rpc=rpc)
            adapter.refresh.return_value['voices'] = []
            adapter.refresh.return_value['voices_error'] = 'catalog unavailable'
            params = {} if voice_name is None else {'voice_name': voice_name}
            self.start(adapter, **params)
            self.assertNotIn('voice', rpc.calls[0][1])

    def test_unsupported_or_unavailable_selected_voice_is_rejected(self):
        for voice_name, catalog, error in (
            ('not-supported', ['juniper'], ''),
            ('juniper', [], 'catalog unavailable'),
            (42, ['juniper'], ''),
        ):
            rpc = FakeRPC()
            adapter = self.make_adapter(rpc=rpc)
            adapter.refresh.return_value['voices'] = catalog
            adapter.refresh.return_value['voices_error'] = error
            with self.assertRaises(ValueError):
                self.start(adapter, voice_name=voice_name)
            self.assertEqual(rpc.calls, [])

    def test_voice_catalog_reads_only_v3_deduplicates_and_caches_for_ttl(self):
        rpc = FakeRPC()
        rpc.result = {'voices': {'v1': ['ignored-v1'], 'v2': ['ignored-v2'],
                                 'v3': ['juniper', 'maple', 'juniper', '', 'bad voice', 'x' * 65]}}
        adapter = self.make_adapter(rpc=rpc)
        self.assertEqual(adapter.read_voices(), ['juniper', 'maple'])
        self.assertEqual(adapter.read_voices(), ['juniper', 'maple'])
        self.assertEqual(rpc.calls, [('thread/realtime/listVoices', {}, {})])
        adapter.voices_at = 0
        self.assertEqual(adapter.read_voices(), ['juniper', 'maple'])
        self.assertEqual(len(rpc.calls), 2)

    def test_voice_catalog_cache_is_keyed_by_rpc_and_errors_retry_after_backoff(self):
        rpc = FakeRPC()
        rpc.result = {'voices': {'v3': ['juniper']}}
        adapter = self.make_adapter(rpc=rpc)
        self.assertEqual(adapter.read_voices(), ['juniper'])

        replacement = FakeRPC()
        replacement.result = {'voices': {'v3': ['maple']}}
        adapter.controls.rpc = replacement
        self.assertEqual(adapter.read_voices(), ['maple'])
        self.assertEqual(len(replacement.calls), 1)

        replacement.result = {'voices': {'v3': 'malformed'}}
        adapter.voices_at = 0
        with self.assertRaisesRegex(ValueError, 'malformed v3'):
            adapter.read_voices()
        self.assertEqual(adapter.voices, [])
        self.assertTrue(adapter.voices_error)
        calls = len(replacement.calls)
        with self.assertRaises(ValueError):
            adapter.read_voices()
        self.assertEqual(len(replacement.calls), calls)
        replacement.result = {'voices': {'v3': []}}
        adapter.voices_at = 0
        with self.assertRaisesRegex(ValueError, 'no usable'):
            adapter.read_voices()

    def test_rejects_unknown_stale_or_unloaded_session_before_rpc(self):
        for rows, loaded, params in (
            ([], True, {}),
            ([{'id': 'other-agent', 'session_id': 'thread-1'}], True, {}),
            (None, False, {}),
            (None, True, {'id': 'agent-1', 'session_id': 'stale-thread'}),
        ):
            rpc = FakeRPC()
            adapter = self.make_adapter(rows=rows, rpc=rpc, loaded=loaded)
            with self.assertRaises(ValueError):
                self.start(adapter, **params)
            self.assertEqual(rpc.calls, [])

    def test_rejects_disconnected_rpc_and_second_active_voice(self):
        rpc = FakeRPC(connected=False)
        adapter = self.make_adapter(rpc=rpc)
        with self.assertRaisesRegex(ValueError, 'connected Codex'):
            self.start(adapter)
        self.assertEqual(rpc.calls, [])
        rpc.connected = True
        self.start(adapter)
        with self.assertRaisesRegex(ValueError, 'already active'):
            self.start(adapter, voice_id='voice-2')

    def test_start_validates_id_lengths_and_audio_offer(self):
        invalid = (
            {'voice_id': 'v' * 129},
            {'session_id': 's' * 129},
            {'sdp': 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 111\r\n'},
            {'sdp': 'not-an-sdp\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'},
            {'sdp': 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' + ('x' * 262145)},
        )
        for changes in invalid:
            rpc = FakeRPC()
            adapter = self.make_adapter(rpc=rpc)
            with self.assertRaises(ValueError):
                self.start(adapter, **changes)
            self.assertEqual(rpc.calls, [])

    def test_stop_is_scoped_idempotent_and_does_not_stop_newer_voice(self):
        rpc = FakeRPC()
        adapter = self.make_adapter(rpc=rpc)
        self.start(adapter)
        with self.assertRaisesRegex(ValueError, 'does not match'):
            adapter.handle('voice-stop', {'voice_id': 'foreign'})
        self.assertEqual(len(rpc.calls), 1)
        self.assertEqual(adapter.handle('voice-stop', {'voice_id': 'voice-1'}), {})
        self.assertEqual(adapter.handle('voice-stop', {'voice_id': 'voice-1'}), {})
        self.assertEqual(rpc.calls[-1][:2], ('thread/realtime/stop', {'threadId': 'thread-1'}))
        self.assertIsNotNone(adapter.voice)
        with self.assertRaisesRegex(ValueError, 'already active'):
            self.start(adapter, voice_id='voice-2')
        self.expire_stop_grace(adapter)
        self.start(adapter, voice_id='voice-2')
        self.assertEqual(adapter.handle('voice-stop', {'voice_id': 'voice-1'}), {})
        self.assertEqual(adapter.voice['id'], 'voice-2')

    def test_notifications_forward_safe_metadata_then_cleanup(self):
        adapter = self.make_adapter()
        self.start(adapter)
        adapter.message({'method': 'thread/realtime/sdp', 'params': {
            'threadId': 'thread-1', 'sdp': 'answer', 'audio': 'must-not-forward'}})
        adapter.message({'method': 'thread/realtime/outputAudio/delta', 'params': {
            'threadId': 'thread-1', 'delta': 'audio-bytes'}})
        adapter.message({'method': 'thread/realtime/transcript/delta', 'params': {
            'threadId': 'thread-1', 'role': 'user', 'delta': 'hello', 'audio': 'secret'}})
        self.assertEqual(adapter.voice_events[0]['params'], {'threadId': 'thread-1', 'sdp': 'answer'})
        self.assertEqual(adapter.voice_events[1]['params'], {'threadId': 'thread-1', 'role': 'user', 'delta': 'hello'})
        self.assertEqual(len(adapter.voice_events), 2)
        adapter.message({'method': 'thread/realtime/closed', 'params': {'threadId': 'thread-1'}})
        self.assertIsNone(adapter.voice)
        self.assertEqual(adapter.voice_events[-1]['method'], 'thread/realtime/closed')
        self.assertEqual(sum(event['method'] == 'thread/realtime/closed' for event in adapter.voice_events), 1)

    def test_error_is_forwarded_once_and_keeps_ownership_until_native_stop(self):
        rpc = FakeRPC()
        adapter = self.make_adapter(rpc=rpc)
        self.start(adapter)
        error = {'method': 'thread/realtime/error', 'params': {'threadId': 'thread-1', 'message': 'failed'}}
        adapter.message(error)
        self.assertIsNotNone(adapter.voice)
        self.assertEqual(sum(event['method'] == 'thread/realtime/error' for event in adapter.voice_events), 1)
        self.assertEqual(adapter.handle('voice-stop', {'voice_id': 'voice-1'}), {})
        self.assertIsNotNone(adapter.voice)
        self.assertEqual(rpc.calls[-1][:2], ('thread/realtime/stop', {'threadId': 'thread-1'}))
        self.expire_stop_grace(adapter)
        self.assertIsNone(adapter.voice)

    def test_dead_rpc_cleans_up_without_attempting_native_stop(self):
        rpc = FakeRPC()
        adapter = self.make_adapter(rpc=rpc)
        self.start(adapter)
        rpc.connected = False
        self.assertEqual(adapter.handle('voice-stop', {'voice_id': 'voice-1'}), {})
        self.assertIsNone(adapter.voice)
        self.assertEqual([call[0] for call in rpc.calls], ['thread/realtime/start'])

    def test_disconnect_and_thread_close_cleanup_voice(self):
        for notification in (
            {'method': 'connection/closed', 'params': {'error': 'gone'}},
            {'method': 'thread/closed', 'params': {'threadId': 'thread-1'}},
        ):
            adapter = self.make_adapter()
            self.start(adapter)
            adapter.message(notification)
            self.assertIsNone(adapter.voice)
            self.assertIn(adapter.voice_events[-1]['method'],
                          {'connection/closed', 'thread/closed'})
            self.assertEqual(adapter.handle('voice-stop', {'voice_id': 'voice-1'}), {})

    def test_start_failure_releases_ownership(self):
        rpc = FakeRPC()
        rpc.request = Mock(side_effect=RuntimeError('rejected'))
        adapter = self.make_adapter(rpc=rpc)
        with self.assertRaisesRegex(RuntimeError, 'rejected'):
            self.start(adapter)
        self.assertIsNone(adapter.voice)


if __name__ == '__main__':
    unittest.main()
