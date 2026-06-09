"""ShotComfy bridge: lets ShotComfy talk to the OPEN ComfyUI tab.

Routes:
  POST /shotcomfy/load     workflow (UI graph) -> broadcast "shotcomfy.load";
                           the web extension calls app.loadGraphData() to open it.
  POST /shotcomfy/convert  {id, graph} -> broadcast "shotcomfy.convert"; the web
                           extension converts the UI graph to API format via
                           app.graphToPrompt() and POSTs it back to /shotcomfy/api_result.
  POST /shotcomfy/api_result  {id, prompt|error} from the web extension (stored).
  GET  /shotcomfy/api_result?id=  -> ShotComfy polls for the converted prompt.
"""
from aiohttp import web
from server import PromptServer

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# id -> {"prompt": {...}} | {"error": "..."} produced by the web extension
_results: dict[str, dict] = {}


@PromptServer.instance.routes.post("/shotcomfy/load")
async def _shotcomfy_load(request):
    try:
        data = await request.json()
    except Exception as e:  # noqa: BLE001
        return web.json_response({"ok": False, "error": str(e)}, status=400)
    PromptServer.instance.send_sync("shotcomfy.load", data)
    return web.json_response({"ok": True})


@PromptServer.instance.routes.post("/shotcomfy/convert")
async def _shotcomfy_convert(request):
    """Ask the open ComfyUI tab to convert a UI graph to API format."""
    try:
        data = await request.json()
    except Exception as e:  # noqa: BLE001
        return web.json_response({"ok": False, "error": str(e)}, status=400)
    rid = str(data.get("id"))
    _results.pop(rid, None)
    PromptServer.instance.send_sync("shotcomfy.convert", {"id": rid, "graph": data.get("graph")})
    return web.json_response({"ok": True, "id": rid})


@PromptServer.instance.routes.post("/shotcomfy/api_result")
async def _shotcomfy_api_result(request):
    try:
        data = await request.json()
    except Exception as e:  # noqa: BLE001
        return web.json_response({"ok": False, "error": str(e)}, status=400)
    _results[str(data.get("id"))] = data
    return web.json_response({"ok": True})


@PromptServer.instance.routes.get("/shotcomfy/api_result")
async def _shotcomfy_get_api_result(request):
    rid = request.query.get("id", "")
    res = _results.pop(rid, None)
    if res is None:
        return web.json_response({"pending": True})
    return web.json_response(res)


@PromptServer.instance.routes.get("/shotcomfy/ping")
async def _shotcomfy_ping(request):
    return web.json_response({"ok": True, "bridge": "shotcomfy"})


__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
