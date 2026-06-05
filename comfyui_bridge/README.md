# ShotComfy ComfyUI bridge

A tiny ComfyUI custom node that lets ShotComfy load a workflow into the **already
open** ComfyUI editor (the "🧩 ワークフローをComfyUIに展開" menu).

It adds:
- `POST /shotcomfy/load` — receives a workflow (UI graph) and broadcasts it over the
  ComfyUI websocket.
- a web extension that calls `app.loadGraphData()` to open it in the live editor.

No pip dependencies (uses ComfyUI's bundled `aiohttp` + `server`).

## Install on any PC

1. Copy the `shotcomfy_bridge/` folder into ComfyUI's **`custom_nodes/`**.
   - Standard install: `<ComfyUI>/custom_nodes/shotcomfy_bridge/`
   - Windows portable build: the code root is nested, e.g.
     `…\ComfyUI_windows_portable\ComfyUI\custom_nodes\shotcomfy_bridge\`
2. Restart ComfyUI, then reload the ComfyUI browser tab (so the web extension loads).
3. In ShotComfy's `config.json`, point `comfyui.base_url` at that ComfyUI
   (e.g. `http://127.0.0.1:8188`).

Verify: `GET http://<comfyui>/shotcomfy/ping` → `{"ok": true, "bridge": "shotcomfy"}`.

If the bridge isn't installed, ShotComfy falls back to saving the workflow JSON into
ComfyUI's `user/default/workflows/` folder instead.
