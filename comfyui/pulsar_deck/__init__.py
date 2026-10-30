"""Optional read-only ComfyUI progress endpoint for Pulsar Codex Deck.

Copy this folder into ComfyUI/custom_nodes and restart ComfyUI.
No nodes, execution hooks, WebSocket changes or extra packages are installed.
"""
from aiohttp import web
from server import PromptServer

NODE_CLASS_MAPPINGS = {}


def progress_snapshot(server, registry=None):
    queue = server.prompt_queue
    read_queue = getattr(queue, 'get_current_queue_volatile', queue.get_current_queue)
    running, _ = read_queue()
    result = {"version": 1, "prompt_id": "", "node": "", "value": None, "max": None}
    if not running:
        return result
    item = running[0]
    result["prompt_id"] = item[1]
    node_id = getattr(server, "last_node_id", None)
    if registry is not None and registry.prompt_id == item[1]:
        active = [(key, value) for key, value in list(registry.nodes.items())
                  if getattr(value.get("state"), "value", value.get("state")) == "running"]
        if active:
            node_id, state = active[-1]
            result["value"], result["max"] = state.get("value"), state.get("max")
    node = item[2].get(str(node_id), {}) if len(item) > 2 else {}
    result["node"] = str(node.get("_meta", {}).get("title") or node.get("class_type") or node_id or "")[:100]
    return result


@PromptServer.instance.routes.get("/pulsar-deck/status")
async def status(_request):
    registry = None
    try:
        from comfy_execution import progress
        registry = getattr(progress, 'global_progress_registry', None)
    except (ImportError, AttributeError):
        pass  # Older ComfyUI releases still provide the node name.
    return web.json_response(progress_snapshot(PromptServer.instance, registry))
