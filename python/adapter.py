"""Standalone session integration and exact-request controls over private stdio."""
import argparse
import hashlib
import json
import logging
from pathlib import Path
import sys
import time

MODES = {
    "Read-only": {"approvalPolicy": "on-request", "sandboxPolicy": {"type": "readOnly"}},
    "Auto": {"approvalPolicy": "on-request", "sandboxPolicy": {"type": "workspaceWrite", "networkAccess": False}},
    "No prompts": {"approvalPolicy": "never", "sandboxPolicy": {"type": "workspaceWrite", "networkAccess": False}},
    "YOLO / Full access": {"approvalPolicy": "never", "sandboxPolicy": {"type": "dangerFullAccess"}},
}


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def effective_settings(value):
    settings = {key: value.get(key) for key in ("approvalPolicy", "approvalsReviewer", "cwd",
                "model", "modelProvider", "activePermissionProfile")}
    settings["sandboxPolicy"] = value.get("sandboxPolicy", value.get("sandbox"))
    settings["effort"] = value.get("effort", value.get("reasoningEffort"))
    if settings["effort"] is None:
        settings["effort"] = (value.get("collaborationMode") or {}).get("settings", {}).get("reasoning_effort")
    return settings


class Adapter:
    def __init__(self, root=None, store=None):
        if root:
            sys.path.insert(0, str(Path(root) / "bridge"))
        from agent_deck.model import Deck
        from agent_deck.store import EventReader
        from agent_deck.controls import Controls
        from agent_deck.focus import FocusRunner
        self.deck, self.reader = Deck(), EventReader(store)
        from hook_setup import codex_executable
        from agent_deck.codex_rpc import CodexRPC
        self.controls = Controls(rpc_factory=lambda on_message: CodexRPC(on_message, executable=codex_executable()))
        self.focus = FocusRunner()
        self.cursor = 0
        self.settings = {}
        self.settings_errors = {}
        self.settings_at = 0
        self.models, self.models_error, self.models_at = [], "", 0
        self.original_message = self.controls._message
        self.controls._message = self.message

    def message(self, message):
        if message.get("method") == "thread/settings/updated":
            p = message["params"]
            value = p["threadSettings"]
            self.settings[p["threadId"]] = effective_settings(value)
        self.original_message(message)

    def refresh(self):
        from agent_deck.processes import is_alive, classify_owner
        while True:
            events = self.reader.read(self.cursor)
            for index, event in events:
                self.deck.apply(index, event)
                self.cursor = index
            if len(events) < 1000:
                break
        for key, agent in list(self.deck.agents.items()):
            alive = is_alive(agent.owner_pid, agent.owner_created)
            if alive is False:
                del self.deck.agents[key]
            elif alive is True and agent.owner_kind == 'unknown':
                agent.owner_kind = classify_owner(agent.owner_pid, agent.owner_created)
        rows = self.deck.view(limit=None)
        self.controls.sync(rows)
        self.controls.decorate(rows)
        if self.controls.connected:
            try:
                self.read_models()
            except Exception:
                pass  # Surface catalog errors without disabling existing controls.
        else:
            self.models, self.models_error, self.models_at = [], "Codex is disconnected", 0
        if self.controls.connected and time.monotonic() >= self.settings_at:
            self.settings_at = time.monotonic() + 5
            for row in rows:
                thread = row["session_id"]
                if thread not in self.controls.contexts:
                    continue
                try:
                    self.read_settings(thread)
                    self.settings_errors.pop(thread, None)
                except Exception as error:
                    self.settings.pop(thread, None)
                    self.settings_errors[thread] = str(error)
        for row in rows:
            thread = row["session_id"]
            if not self.focus.enabled:
                row["actions"] = [x for x in row["actions"] if x != "focus"]
            if self.controls.connected and thread in self.controls.contexts and thread in self.settings:
                row["settings"] = self.settings[thread]
                row["settings_token"] = fingerprint(self.settings[thread])
            else:
                row["settings"] = None
                row["settings_token"] = None
            row["settings_error"] = self.settings_errors.get(thread, "")
        from hook_setup import diagnostics
        return {"rows": rows, "connected": self.controls.connected, "error": self.controls.error, 'diagnostics': diagnostics(),
                "store": str(self.reader.path), "models": self.models, "models_error": self.models_error,
                "models_token": fingerprint(self.models) if self.models and not self.models_error else None}

    def handle(self, method, params):
        if method == 'setup-hooks':
            from hook_setup import install_hooks
            result = install_hooks(apply=True)
            return {**self.refresh(), 'setup_message': result['message']}
        if method == "refresh":
            return self.refresh()
        if method not in {"action", "settings", "configuration"}:
            raise ValueError("Unknown operation")
        snapshot = self.refresh()
        row = next((x for x in snapshot["rows"] if x["id"] == params.get("id") and
                    x["session_id"] == params.get("session_id")), None)
        if row is None:
            raise ValueError("Session is no longer available")
        if method == "action":
            verb = params["verb"]
            if params.get("token") != row["control_token"] or verb not in row["actions"]:
                raise ValueError("Session or request changed. Review it again.")
            if verb == "focus":
                self.focus.open_session(row["session_id"], row.get("tab", ""), row["project"]).result(timeout=20)
            else:
                self.controls.execute(row["session_id"], verb, params["token"])
        elif method == "settings":
            if params.get("mode") not in MODES:
                raise ValueError("Unknown permission mode")
            current = self.read_settings(row["session_id"])
            if not row["settings_token"] or params.get("token") != fingerprint(current):
                raise ValueError("Settings changed. Review them again.")
            self.controls.rpc.request("thread/settings/update", {
                "threadId": row["session_id"], **MODES[params["mode"]]})
            self.read_settings(row["session_id"])
        else:
            self.configure(row, params)
        return self.refresh()

    def read_models(self, force=False):
        if not force and time.monotonic() < self.models_at:
            if self.models_error:
                raise ValueError(self.models_error)
            return self.models
        try:
            models, cursor, seen, ids = [], None, set(), set()
            for _ in range(20):
                params = {"limit": 100, "includeHidden": False}
                if cursor:
                    params["cursor"] = cursor
                result = self.controls.rpc.request("model/list", params)
                for item in result["data"]:
                    model = item.get("model")
                    if item.get("hidden") or not isinstance(model, str) or not model or model in ids:
                        continue
                    efforts = list(dict.fromkeys(option["reasoningEffort"] for option in item.get("supportedReasoningEfforts", [])
                                                 if isinstance(option.get("reasoningEffort"), str) and option["reasoningEffort"]))
                    default = item.get("defaultReasoningEffort")
                    if efforts and default not in efforts:
                        raise ValueError("Model catalog has an unsupported default Effort")
                    models.append({"id": model, "label": item.get("displayName") or model,
                                   "efforts": efforts, "defaultEffort": default if efforts else None})
                    ids.add(model)
                cursor = result.get("nextCursor")
                if not cursor:
                    break
                if cursor in seen:
                    raise ValueError("Model catalog pagination repeated")
                seen.add(cursor)
            else:
                raise ValueError("Model catalog pagination limit reached")
            if not models:
                raise ValueError("No selectable models were returned by Codex")
        except Exception as error:
            self.models, self.models_error, self.models_at = [], str(error), time.monotonic() + 10
            raise
        self.models, self.models_error, self.models_at = models, "", time.monotonic() + 60
        return models

    def configure(self, row, params):
        if params.get("kind") not in {"model", "effort"}:
            raise ValueError("Unknown configuration change")
        current = self.read_settings(row["session_id"])
        if not row.get("settings_token") or params.get("token") != fingerprint(current):
            raise ValueError("Settings changed. Review them again.")
        models = self.read_models(force=True)
        if params.get("catalog_token") != fingerprint(models):
            raise ValueError("Model choices changed. Open the selector again.")
        target = next((m for m in models if m["id"] == params.get("model")), None)
        if not target:
            raise ValueError("Model is no longer available")
        effort = params.get("effort")
        if params["kind"] == "effort":
            if target["id"] != current["model"] or effort not in target["efforts"]:
                raise ValueError("Effort is not supported by the current model")
            update = {"effort": effort}
        else:
            expected = current.get("effort") if current.get("effort") in target["efforts"] else target["defaultEffort"]
            if effort != expected:
                raise ValueError("Model or Effort changed. Review the selection again.")
            update = {"model": target["id"]}
            if effort is not None:
                update["effort"] = effort
        self.controls.rpc.request("thread/settings/update", {"threadId": row["session_id"], **update})
        applied = self.read_settings(row["session_id"])
        if applied.get("model") != target["id"] or (effort is not None and applied.get("effort") != effort):
            raise ValueError("Codex did not confirm the new Model and Effort. Check the session on PC.")

    def read_settings(self, thread):
        # Resume without overrides attaches another view to the loaded thread.
        # The update response is empty in CLI 0.165; resume reports effective values.
        result = self.controls.rpc.request("thread/resume", {"threadId": thread, "excludeTurns": True})
        self.controls.subscribed.add(thread)
        settings = effective_settings(result)
        self.settings[thread] = settings
        return settings

    def close(self):
        self.controls.close()
        self.focus.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', nargs='?', choices=('bridge', 'hook', 'install-hooks', 'uninstall-hooks', 'doctor'), default='bridge')
    parser.add_argument("--agent-deck")
    parser.add_argument("--store")
    parser.add_argument('--hooks-file')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if args.mode == 'hook':
        from agent_deck.hook import main as hook_main
        hook_main()
        return
    if args.mode in ('install-hooks', 'uninstall-hooks'):
        from hook_setup import install_hooks
        print(json.dumps(install_hooks(args.hooks_file, args.apply, args.mode == 'uninstall-hooks'), indent=2))
        return
    if args.mode == 'doctor':
        from hook_setup import diagnostics
        print(json.dumps(diagnostics(), indent=2))
        return
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
    adapter = Adapter(args.agent_deck, args.store)
    try:
        for line in sys.stdin:
            message = {}
            try:
                message = json.loads(line)
                result = adapter.handle(message["method"], message.get("params", {}))
                reply = {"id": message["id"], "result": result}
            except Exception as error:
                reply = {"id": message.get("id"), "error": str(error)}
            print(json.dumps(reply, ensure_ascii=True), flush=True)
    finally:
        adapter.close()


if __name__ == "__main__":
    main()
