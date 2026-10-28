"""Explicit, backed-up hook installation. Never returns approval decisions."""
import copy
from datetime import datetime
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
from agent_deck.hook import EVENTS
from pulsar_paths import default_store


def hook_command():
    argv = [sys.executable, 'hook'] if getattr(sys, 'frozen', False) else [
        sys.executable, str(Path(__file__).with_name('adapter.py')), 'hook']
    return subprocess.list2cmdline(argv) if os.name == 'nt' else shlex.join(argv)


def hooks_path():
    return Path(os.environ.get('CODEX_HOME') or Path.home() / '.codex') / 'hooks.json'


def is_ours(command, current):
    if not isinstance(command, str):
        return False
    return command == current or bool(re.search(r'PulsarBackend(?:\.exe)?["\x27]?\s+hook(?:\s|$)', command, re.I))


def merge_hooks(existing, command, remove=False):
    result = copy.deepcopy(existing)
    hooks = result.setdefault('hooks', {})
    if not isinstance(hooks, dict):
        raise ValueError('Existing hooks must be an object; no configuration was changed.')
    for event, groups in list(hooks.items()):
        if not isinstance(groups, list):
            raise ValueError('Existing hook groups must be lists; no configuration was changed.')
        kept = []
        for group in groups:
            if not isinstance(group, dict) or not isinstance(group.get('hooks'), list):
                raise ValueError('Invalid hook group; no configuration was changed.')
            entries = [h for h in group['hooks'] if not is_ours(h.get('commandWindows', h.get('command')), command)]
            if entries:
                kept.append({**group, 'hooks': entries})
            elif not group['hooks']:
                kept.append(group)
        hooks[event] = kept
    if not remove:
        for event in sorted(EVENTS):
            entry = {'type': 'command', 'command': command, 'timeout': 3}
            if os.name == 'nt':
                entry['commandWindows'] = command
            group = {'hooks': [entry]}
            if event == 'PreToolUse':
                group['matcher'] = 'request_user_input'
            hooks.setdefault(event, []).append(group)
    return result


def install_hooks(path=None, apply=False, remove=False):
    path = Path(path) if path else hooks_path()
    existing = json.loads(path.read_text(encoding='utf-8-sig')) if path.exists() else {}
    merged = merge_hooks(existing, hook_command(), remove)
    if not apply:
        return {'preview': merged, 'path': str(path), 'changed': existing != merged}
    backup = None
    if merged != existing:
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            backup = path.with_name(path.name + '.pulsar-deck-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f') + '.bak')
            shutil.copy2(path, backup)
        temp = path.with_name(path.name + '.pulsar-deck.tmp')
        temp.write_text(json.dumps(merged, indent=2) + '\n', encoding='utf-8')
        temp.replace(path)
    return {'path': str(path), 'backup': str(backup) if backup else None, 'changed': merged != existing,
            'message': 'Hooks removed.' if remove else 'Hooks installed. In Codex, run /hooks to review and trust them, then start/resume a session and send a prompt.'}


def codex_executable():
    if os.environ.get('PULSAR_CODEX'):
        return os.environ['PULSAR_CODEX']
    found = shutil.which('codex')
    if found:
        return found
    if os.name == 'nt':
        candidate = Path(os.environ.get('LOCALAPPDATA') or Path.home()) / 'Programs/OpenAI/Codex/bin/codex.exe'
        if candidate.is_file():
            return str(candidate)
    return None


def diagnostics():
    path = hooks_path()
    found_hooks = False
    own_hooks = False
    try:
        data = json.loads(path.read_text(encoding='utf-8-sig'))
        for groups in data.get('hooks', {}).values():
            for group in groups:
                for entry in group.get('hooks', []):
                    command = entry.get('commandWindows', entry.get('command', ''))
                    own_hooks = own_hooks or is_ours(command, hook_command())
                    found_hooks = found_hooks or is_ours(command, hook_command()) or 'codex-hook.py' in command or 'AgentDeck.exe' in command
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    return {'codex_installed': bool(codex_executable()), 'hooks_configured': found_hooks,
            'pulsar_hooks': own_hooks, 'hooks_file': str(path), 'event_store': str(default_store())}
