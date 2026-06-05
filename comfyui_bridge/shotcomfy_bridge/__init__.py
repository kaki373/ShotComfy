"""ShotComfy bridge: lets ShotComfy load a workflow into the OPEN ComfyUI tab.

POST /shotcomfy/load  with a workflow (UI graph) JSON body
  -> broadcasts a "shotcomfy.load" websocket event to all connected ComfyUI
     clients; the bundled web extension calls app.loadGraphData() to open it.
"""
from aiohttp import web
from server import PromptServer

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}


@PromptServer.instance.routes.post("/shotcomfy/load")
async def _shotcomfy_load(request):
    try:
        data = await request.json()
    except Exception as e:  # noqa: BLE001
        return web.json_response({"ok": False, "error": str(e)}, status=400)
    PromptServer.instance.send_sync("shotcomfy.load", data)
    return web.json_response({"ok": True})


@PromptServer.instance.routes.get("/shotcomfy/ping")
async def _shotcomfy_ping(request):
    return web.json_response({"ok": True, "bridge": "shotcomfy"})


__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
