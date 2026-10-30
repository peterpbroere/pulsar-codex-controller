"""Optional read-only ComfyUI progress endpoint for Pulsar Codex Deck.

Copy this folder into ComfyUI/custom_nodes and restart ComfyUI.
Observes progress notifications without changing workflows or browser messages.
"""
from threading import Lock
from aiohttp import web
from server import PromptServer

NODE_CLASS_MAPPINGS = {}


class ProgressEvents:
    def __init__(self):
        self.lock = Lock()
        self.prompt_id = None
        self.completed = set()

    def record(self, event, data):
        if event not in ('execution_start', 'execution_cached', 'executed') or not isinstance(data, dict):
            return
        prompt_id = data.get('prompt_id')
        if not isinstance(prompt_id, str) or not prompt_id:
            return
        with self.lock:
            if event == 'execution_start':
                self.prompt_id = prompt_id
                self.completed.clear()
            elif prompt_id == self.prompt_id:
                nodes = data.get('nodes', []) if event == 'execution_cached' else [data.get('node')]
                if isinstance(nodes, list):
                    self.completed.update(str(node) for node in nodes if isinstance(node, (str, int)))

    def total(self, prompt_id, nodes):
        with self.lock:
            if prompt_id != self.prompt_id:
                return None
            # Match ComfyUI's queue indicator: cached/executed nodes divided by queued nodes.
            total = len(set(nodes) | self.completed)
            return {'value': len(self.completed), 'max': total} if total else None


def observe_notifications(server, events):
    send = server.send_sync

    def forward(event, data, sid=None):
        events.record(event, data)
        return send(event, data, sid)

    server.send_sync = forward


def progress_snapshot(server, registry=None, events=None):
    queue = server.prompt_queue
    read_queue = getattr(queue, 'get_current_queue_volatile', queue.get_current_queue)
    running, _ = read_queue()
    result = {"version": 1, "prompt_id": "", "node": "", "value": None, "max": None, "total": None}
    if not running:
        return result
    item = running[0]
    result["prompt_id"] = item[1]
    prompt = item[2] if len(item) > 2 else {}
    if events is not None:
        result['total'] = events.total(item[1], prompt)
    node_id = getattr(server, "last_node_id", None)
    if registry is not None and registry.prompt_id == item[1]:
        active = [(key, value) for key, value in list(registry.nodes.items())
                  if getattr(value.get("state"), "value", value.get("state")) == "running"]
        if active:
            node_id, state = active[0]
            result["value"], result["max"] = state.get("value"), state.get("max")
    node = prompt.get(str(node_id), {})
    if not node and registry is not None and registry.prompt_id == item[1]:
        display_id = registry.dynprompt.get_display_node_id(node_id)
        node = prompt.get(str(display_id), {})
    result["node"] = str(node.get("_meta", {}).get("title") or node.get("class_type") or node_id or "")[:100]
    return result


events = ProgressEvents()
observe_notifications(PromptServer.instance, events)


@PromptServer.instance.routes.get("/pulsar-deck/status")
async def status(_request):
    registry = None
    try:
        from comfy_execution import progress
        registry = getattr(progress, 'global_progress_registry', None)
    except (ImportError, AttributeError):
        pass  # Older ComfyUI releases still provide the node name.
    return web.json_response(progress_snapshot(PromptServer.instance, registry, events))
