"""Stable standalone paths, with optional Agent Deck journal compatibility."""
import os
from pathlib import Path


def default_store():
    if os.environ.get('PULSAR_EVENT_STORE'):
        return Path(os.environ['PULSAR_EVENT_STORE']).expanduser()
    if os.environ.get('AGENT_DECK_STATE_DIR'):
        return Path(os.environ['AGENT_DECK_STATE_DIR']).expanduser() / 'events.sqlite3'
    base = Path(os.environ.get('LOCALAPPDATA') or Path.home() / '.local/share')
    shared = base / 'FlipperAgentDeck/events.sqlite3'
    return shared if shared.is_file() else base / 'PulsarCodexDeck/events.sqlite3'
