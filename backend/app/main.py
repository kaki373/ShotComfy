"""ShotComfy backend (FastAPI).

API contract (frontend depends on this):
  GET  /api/health                      -> {ok, mode, config_source}
  GET  /api/config                      -> {mode, comfyui_url, target}
  GET  /api/comfyui/status              -> ComfyUI system_stats + {online}
  GET  /api/boards                      -> [{id,label,episode,cut,path}]
  GET  /api/boards/{board_id:path}      -> {id,label,...,assets:[{name,path,kind,...}]}
  GET  /api/asset?path=<abs>            -> the media file (validated to allowed roots)
  POST /api/queue  {board_ids, workflow, params}  -> {queued:[...]}  (stub for now)
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import json
import subprocess
import sys
import httpx
from PIL import Image
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .comfyui import ComfyUI
from .config import load_config, save_config
from .jobs import run_queue
from .library import build_library
from .library.base import kind_of
from .metadata import build_lineage
from .tags import load_tags, set_tag

app = FastAPI(title="ShotComfy", version="0.0.1")

app.add_middleware(
    CORSMiddleware,
    # Vite dev may fall back to 5174+ if 5173 is taken; allow any localhost port.
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
    allow_methods=["*"],
    allow_headers=["*"],
)


class _State:
    def __init__(self) -> None:
        self.reload()

    def reload(self) -> None:
        self.cfg = load_config()
        self.library = build_library(self.cfg)
        self.comfy = ComfyUI(self.cfg["comfyui"]["base_url"])
        self.allowed_roots = self._compute_allowed_roots()

    def _compute_allowed_roots(self) -> list[Path]:
        roots: list[Path] = []
        try:
            roots.append(Path(self.library.root).resolve())  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            pass
        out = self.cfg.get("comfyui", {}).get("output_dir")
        if out:
            roots.append(Path(out).resolve())
        return roots

    def is_allowed(self, path: Path) -> bool:
        try:
            rp = path.resolve()
        except Exception:  # noqa: BLE001
            return False
        for root in self.allowed_roots:
            try:
                rp.relative_to(root)
                return True
            except ValueError:
                continue
        return False


state = _State()


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"ok": True, "mode": state.cfg.get("mode"), "config_source": state.cfg.get("_source")}


@app.get("/api/config")
def get_config() -> dict[str, Any]:
    mode = state.cfg.get("mode", "free")
    target = state.cfg.get(mode, {})
    return {"mode": mode, "comfyui_url": state.cfg["comfyui"]["base_url"], "target": target}


@app.get("/api/comfyui/status")
async def comfyui_status() -> dict[str, Any]:
    return await state.comfy.status()


@app.get("/api/boards")
def list_boards() -> list[dict[str, Any]]:
    return [
        {"id": b.id, "label": b.label, "episode": b.episode, "cut": b.cut, "path": b.path}
        for b in state.library.list_boards()
    ]


@app.get("/api/tree")
def get_tree() -> dict[str, Any]:
    return state.library.tree()


@app.get("/api/lineage/{board_id:path}")
def get_lineage(board_id: str) -> dict[str, Any]:
    b = state.library.get_board(board_id)
    if b is None:
        raise HTTPException(status_code=404, detail=f"board not found: {board_id}")
    return build_lineage(b)


@app.get("/api/tags/{board_id:path}")
def get_tags(board_id: str) -> dict[str, Any]:
    b = state.library.get_board(board_id)
    if b is None:
        raise HTTPException(status_code=404, detail=f"board not found: {board_id}")
    return load_tags(b.path)


class TagRequest(BaseModel):
    name: str
    source: str | None = None
    ok: bool | None = None
    labels: list[str] | None = None


@app.post("/api/tags/{board_id:path}")
def post_tag(board_id: str, req: TagRequest) -> dict[str, Any]:
    b = state.library.get_board(board_id)
    if b is None:
        raise HTTPException(status_code=404, detail=f"board not found: {board_id}")
    patch: dict[str, Any] = {}
    if req.source is not None:
        patch["source"] = req.source
    if req.ok is not None:
        patch["ok"] = req.ok
    if req.labels is not None:
        patch["labels"] = req.labels
    return {"name": req.name, "tag": set_tag(b.path, req.name, patch)}


@app.get("/api/boards/{board_id:path}")
def get_board(board_id: str) -> dict[str, Any]:
    b = state.library.get_board(board_id)
    if b is None:
        raise HTTPException(status_code=404, detail=f"board not found: {board_id}")
    return {
        "id": b.id, "label": b.label, "episode": b.episode, "cut": b.cut, "path": b.path,
        "assets": [
            {"name": a.name, "path": a.path, "kind": a.kind, "size": a.size, "mtime": a.mtime}
            for a in b.assets
        ],
    }


@app.get("/api/asset")
def get_asset(path: str = Query(...)) -> FileResponse:
    p = Path(path)
    if not state.is_allowed(p):
        raise HTTPException(status_code=403, detail="path not allowed")
    if not p.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    return FileResponse(str(p))


class QueueRequest(BaseModel):
    board_ids: list[str]
    workflow: str | dict[str, Any]
    params: dict[str, Any] = {}


@app.post("/api/queue")
async def queue(req: QueueRequest) -> dict[str, Any]:
    try:
        results = await run_queue(
            state.comfy, state.library, req.board_ids, req.workflow, req.params
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"workflow": req.workflow if isinstance(req.workflow, str) else "<inline>", "results": results}


@app.post("/api/upload")
async def upload(
    board_id: str = Form("."),
    files: list[UploadFile] = File(...),
) -> dict[str, Any]:
    """Save dropped files into a board's folder so they become real assets."""
    board = state.library.get_board(board_id)
    if board is None:
        raise HTTPException(status_code=404, detail=f"board not found: {board_id}")
    saved: list[dict[str, Any]] = []
    for f in files:
        safe = Path(f.filename or "file").name  # strip any path components
        dest = Path(board.path) / safe
        dest.write_bytes(await f.read())
        saved.append({"name": dest.name, "path": str(dest), "kind": kind_of(dest)})
    return {"board": board_id, "saved": saved}


class WorkdirRequest(BaseModel):
    folder: str


@app.post("/api/workdir")
def set_workdir(req: WorkdirRequest) -> dict[str, Any]:
    """Switch free-mode working folder, persist it, and reload the library."""
    p = Path(req.folder)
    if not p.is_dir():
        raise HTTPException(status_code=400, detail=f"not a directory: {req.folder}")
    state.cfg["mode"] = "free"
    state.cfg.setdefault("free", {})["folder"] = str(p)
    save_config(state.cfg)
    state.reload()
    boards = [
        {"id": b.id, "label": b.label, "episode": b.episode, "cut": b.cut, "path": b.path}
        for b in state.library.list_boards()
    ]
    return {"mode": "free", "folder": str(p), "boards": boards}


class OpenRequest(BaseModel):
    folder: str
    mode: str | None = None  # "free" | "project"; None keeps current mode
    code: str | None = None  # project code; defaults to folder name


@app.post("/api/open")
def open_folder(req: OpenRequest) -> dict[str, Any]:
    """Open a folder as the root for free (working folder) or project (root) mode."""
    p = Path(req.folder)
    if not p.is_dir():
        raise HTTPException(status_code=400, detail=f"not a directory: {req.folder}")
    mode = req.mode or state.cfg.get("mode", "free")
    if mode == "project":
        state.cfg["mode"] = "project"
        proj = state.cfg.setdefault("project", {})
        proj["root"] = str(p)
        proj["code"] = req.code or p.name
    else:
        state.cfg["mode"] = "free"
        state.cfg.setdefault("free", {})["folder"] = str(p)
    save_config(state.cfg)
    state.reload()
    return {"mode": state.cfg["mode"], "target": state.cfg.get(state.cfg["mode"], {}), "tree": state.library.tree()}


class ModeRequest(BaseModel):
    mode: str


@app.post("/api/mode")
def set_mode(req: ModeRequest) -> dict[str, Any]:
    """Switch between free/project using the folders already in config."""
    if req.mode not in ("free", "project"):
        raise HTTPException(status_code=400, detail="mode must be free or project")
    state.cfg["mode"] = req.mode
    save_config(state.cfg)
    state.reload()
    return {"mode": req.mode, "target": state.cfg.get(req.mode, {}), "tree": state.library.tree()}


class ExpandRequest(BaseModel):
    path: str


@app.post("/api/expand-workflow")
def expand_workflow(req: ExpandRequest) -> dict[str, Any]:
    """Extract the ComfyUI UI workflow from a PNG and drop it into ComfyUI's
    workflows folder so it shows up in ComfyUI's workflow list."""
    p = Path(req.path)
    if not state.is_allowed(p):
        raise HTTPException(status_code=403, detail="path not allowed")
    if not p.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    try:
        text = dict(getattr(Image.open(p), "text", {}) or {})
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"cannot read image: {e}")
    wf = text.get("workflow")
    if not wf:
        raise HTTPException(status_code=400, detail="この画像にComfyUIワークフローがありません")
    base = state.cfg["comfyui"]["base_url"]

    # 1) try to load it live into the OPEN ComfyUI tab via the bridge extension
    try:
        graph = json.loads(wf)
        r = httpx.post(f"{base}/shotcomfy/load", json=graph, timeout=5.0)
        if r.status_code == 200:
            return {"ok": True, "mode": "live", "comfyui_url": base}
    except Exception:  # noqa: BLE001 - bridge not installed / ComfyUI closed -> fall back
        pass

    # 2) fallback: drop the workflow into ComfyUI's workflows folder
    install = state.cfg["comfyui"].get("install_path", "")
    wdir = Path(install) / "user" / "default" / "workflows"
    wdir.mkdir(parents=True, exist_ok=True)
    name = f"{p.stem}.json"
    (wdir / name).write_text(wf, encoding="utf-8")
    return {"ok": True, "mode": "file", "name": name, "saved": str(wdir / name), "comfyui_url": base}


class RevealRequest(BaseModel):
    path: str


@app.post("/api/reveal")
def reveal(req: RevealRequest) -> dict[str, Any]:
    """Open the OS file explorer with the given file selected (Windows)."""
    p = Path(req.path)
    if not state.is_allowed(p):
        raise HTTPException(status_code=403, detail="path not allowed")
    if not p.exists():
        raise HTTPException(status_code=404, detail="file not found")
    try:
        subprocess.Popen(["explorer", f"/select,{p}"])  # explorer returns nonzero; ignore
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True}


@app.get("/api/pick-folder")
def pick_folder() -> dict[str, Any]:
    """Open a native OS folder-picker on the server machine (best effort).

    Runs tkinter in a child process so a GUI failure can't crash the server.
    """
    code = (
        "import tkinter as tk;from tkinter import filedialog;"
        "r=tk.Tk();r.withdraw();r.attributes('-topmost',True);"
        "print(filedialog.askdirectory());r.destroy()"
    )
    try:
        out = subprocess.run(
            [sys.executable, "-c", code], capture_output=True, text=True, timeout=180
        )
        folder = out.stdout.strip()
        return {"folder": folder or None}
    except Exception as e:  # noqa: BLE001 - picker is best-effort
        return {"folder": None, "error": str(e)}
