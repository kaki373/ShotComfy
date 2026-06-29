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

import asyncio
import json
import shutil
import subprocess
import sys
import httpx
import imageio_ffmpeg
from PIL import Image
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .comfyui import ComfyUI
from .config import load_config, save_config
from .jobs import WORKFLOWS_DIR, list_workflows, run_jobs, run_queue, ui_sources_needing_convert
from .library import build_library
from .library.base import kind_of
from .metadata import build_lineage
from .tags import load_tags, set_tag

app = FastAPI(title="ShotComfy", version="0.0.1")

app.add_middleware(
    CORSMiddleware,
    # Vite dev normally runs on 5273; allow localhost overrides during development.
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


# ---- file operations (right-click menu) ----
_BAD_NAME = set('\\/:*?"<>|')


def _guard(p: Path) -> None:
    if not state.is_allowed(p):
        raise HTTPException(status_code=403, detail=f"path not allowed: {p}")


def _safe_name(name: str) -> str:
    name = name.strip()
    if not name or any(c in _BAD_NAME for c in name):
        raise HTTPException(status_code=400, detail="invalid name")
    return name


def _uniq(p: Path) -> Path:
    if not p.exists():
        return p
    stem, ext, i = p.stem, p.suffix, 2
    while True:
        cand = p.with_name(f"{stem}{i}{ext}")
        if not cand.exists():
            return cand
        i += 1


class PathReq(BaseModel):
    path: str


class RenameReq(BaseModel):
    path: str
    name: str


class ConvertReq(BaseModel):
    path: str
    format: str  # jpg | png


class FolderReq(BaseModel):
    parent: str
    name: str


class MoveReq(BaseModel):
    path: str
    dest: str


@app.post("/api/file/duplicate")
def file_duplicate(req: PathReq) -> dict[str, Any]:
    src = Path(req.path)
    _guard(src)
    if not src.is_file():
        raise HTTPException(status_code=404, detail="not a file")
    dest = _uniq(src.with_name(f"{src.stem}_copy{src.suffix}"))
    shutil.copy2(src, dest)
    return {"ok": True, "path": str(dest), "name": dest.name}


@app.post("/api/file/rename")
def file_rename(req: RenameReq) -> dict[str, Any]:
    src = Path(req.path)
    _guard(src)
    if not src.exists():
        raise HTTPException(status_code=404, detail="not found")
    new = _safe_name(req.name)
    dest = src.with_name(new if Path(new).suffix else new + src.suffix)
    _guard(dest)
    if dest.exists():
        raise HTTPException(status_code=409, detail="name already exists")
    src.rename(dest)
    return {"ok": True, "path": str(dest), "name": dest.name}


@app.post("/api/file/convert")
def file_convert(req: ConvertReq) -> dict[str, Any]:
    src = Path(req.path)
    _guard(src)
    if not src.is_file():
        raise HTTPException(status_code=404, detail="not a file")
    fmt = req.format.lower()
    if fmt not in ("jpg", "jpeg", "png"):
        raise HTTPException(status_code=400, detail="format must be jpg or png")
    ext = ".png" if fmt == "png" else ".jpg"
    dest = src.with_suffix(ext)
    if dest == src or dest.exists():
        dest = _uniq(src.with_name(f"{src.stem}{ext}"))
    try:
        img = Image.open(src)  # PSD opens as its flattened composite
        if ext == ".jpg":
            img.convert("RGB").save(dest, quality=95)
        else:  # png — normalize odd modes (CMYK PSDs etc.)
            if img.mode not in ("RGB", "RGBA", "L", "LA", "P", "I", "1"):
                img = img.convert("RGBA")
            img.save(dest)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"convert failed: {e}")
    return {"ok": True, "path": str(dest), "name": dest.name}


class FrameReq(BaseModel):
    path: str
    position: str  # "first" | "last"


@app.post("/api/video/frame")
def video_frame(req: FrameReq) -> dict[str, Any]:
    """Extract the first or last frame of a video as a PNG still (bundled ffmpeg)."""
    src = Path(req.path)
    _guard(src)
    if not src.is_file():
        raise HTTPException(status_code=404, detail="not a file")
    pos = req.position.lower()
    if pos not in ("first", "last"):
        raise HTTPException(status_code=400, detail="position must be first or last")
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    dest = _uniq(src.with_name(f"{src.stem}_{pos}.png"))
    if pos == "first":
        cmd = [ff, "-y", "-i", str(src), "-frames:v", "1", str(dest)]
    else:  # seek to 3s before end, keep overwriting -> the very last decoded frame
        cmd = [ff, "-y", "-sseof", "-3", "-i", str(src), "-update", "1", "-q:v", "2", str(dest)]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"ffmpeg error: {e}")
    if not dest.exists() or dest.stat().st_size == 0:
        tail = (res.stderr or "")[-300:]
        raise HTTPException(status_code=500, detail=f"フレーム抽出に失敗: {tail}")
    return {"ok": True, "path": str(dest), "name": dest.name}


@app.post("/api/folder/create")
def folder_create(req: FolderReq) -> dict[str, Any]:
    parent = Path(req.parent)
    _guard(parent)
    dest = parent / _safe_name(req.name)
    _guard(dest)
    dest.mkdir(parents=True, exist_ok=True)
    return {"ok": True, "path": str(dest), "name": dest.name}


@app.post("/api/file/move")
def file_move(req: MoveReq) -> dict[str, Any]:
    src = Path(req.path)
    dest_dir = Path(req.dest)
    _guard(src)
    _guard(dest_dir)
    if not src.exists():
        raise HTTPException(status_code=404, detail="source not found")
    if not dest_dir.is_dir():
        raise HTTPException(status_code=400, detail="destination is not a folder")
    dest = dest_dir / src.name
    _guard(dest)
    if dest.exists():
        raise HTTPException(status_code=409, detail="already exists in destination")
    shutil.move(str(src), str(dest))
    return {"ok": True, "path": str(dest), "name": dest.name}


class RestoreReq(BaseModel):
    path: str  # original location to restore to
    src: str  # current (moved) location


@app.post("/api/file/old")
def file_to_old(req: PathReq) -> dict[str, Any]:
    """Soft-delete: move a file/folder into an 'old/' subfolder of its own folder.
    Same volume (works on network drives), recoverable, kept out of the way."""
    p = Path(req.path)
    _guard(p)
    if not p.exists():
        raise HTTPException(status_code=404, detail="not found")
    if p.name.lower() == "old":
        raise HTTPException(status_code=400, detail="already an 'old' folder")
    old_dir = p.parent / "old"
    _guard(old_dir)
    old_dir.mkdir(parents=True, exist_ok=True)
    dest = _uniq(old_dir / p.name)
    shutil.move(str(p), str(dest))
    return {"ok": True, "original": str(p), "moved": str(dest)}


@app.post("/api/file/restore")
def file_restore(req: RestoreReq) -> dict[str, Any]:
    """Undo a move-to-old: move it back from `src` to its original `path`."""
    dest = Path(req.path)
    src = Path(req.src)
    _guard(dest)
    _guard(src)
    if not src.exists():
        raise HTTPException(status_code=404, detail="moved item not found")
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest = _uniq(dest)
    shutil.move(str(src), str(dest))
    return {"ok": True, "path": str(dest)}


@app.post("/api/file/delete")
def file_delete(req: PathReq) -> dict[str, Any]:
    """PERMANENT delete — no recovery. The frontend confirms before calling this."""
    p = Path(req.path)
    _guard(p)
    if not p.exists():
        raise HTTPException(status_code=404, detail="not found")
    if p.is_dir():
        shutil.rmtree(p)
    else:
        p.unlink()
    return {"ok": True, "path": str(p)}


@app.get("/api/asset")
def get_asset(path: str = Query(...)) -> FileResponse:
    p = Path(path)
    if not state.is_allowed(p):
        raise HTTPException(status_code=403, detail="path not allowed")
    if not p.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    return FileResponse(str(p))


# UI-format workflow names currently being auto-converted (dedup background tasks)
_converting: set[str] = set()


async def _auto_convert(name: str) -> None:
    """Background: convert a UI-format <name>.json to <name>_api.json via the open
    ComfyUI tab. Silent — runs only when a ComfyUI tab is connected; no-ops otherwise."""
    if name in _converting:
        return
    _converting.add(name)
    try:
        src = WORKFLOWS_DIR / f"{name}.json"
        out = WORKFLOWS_DIR / f"{name}_api.json"
        if not src.exists():
            return
        graph = json.loads(src.read_text(encoding="utf-8"))
        if not (isinstance(graph, dict) and isinstance(graph.get("nodes"), list)):
            return
        res = await state.comfy.convert_workflow(graph)
        prompt = res.get("prompt")
        if prompt:
            out.write_text(json.dumps(prompt, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:  # noqa: BLE001 - background, never raise
        pass
    finally:
        _converting.discard(name)


@app.get("/api/workflows")
async def get_workflows() -> list[dict[str, Any]]:
    wfs = list_workflows()
    # auto-convert UI-format workflows whose _api cache is missing or stale (non-blocking)
    for name in ui_sources_needing_convert():
        if name not in _converting:
            asyncio.create_task(_auto_convert(name))
    return wfs


class FromImageReq(BaseModel):
    path: str
    name: str | None = None


@app.post("/api/workflows/from-image")
def workflow_from_image(req: FromImageReq) -> dict[str, Any]:
    """Extract the ComfyUI workflow embedded in a PNG (the `workflow` UI graph and/or
    the `prompt` API graph tEXt chunks) into the workflows folder."""
    p = Path(req.path)
    _guard(p)
    if not p.is_file():
        raise HTTPException(status_code=404, detail="not a file")
    try:
        info = Image.open(p).info
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"画像を開けません: {e}")

    def _valid_json(s: Any) -> str | None:
        if not isinstance(s, str):
            return None
        try:
            json.loads(s)
            return s
        except Exception:  # noqa: BLE001
            return None

    ui = _valid_json(info.get("workflow"))  # UI graph (editable)
    api = _valid_json(info.get("prompt"))  # API graph (runnable)
    if not ui and not api:
        raise HTTPException(status_code=400, detail="このPNGにComfyUIのワークフロー情報がありません")

    stem = (req.name or p.stem).strip()
    if not stem or any(c in _BAD_NAME for c in stem):
        raise HTTPException(status_code=400, detail="invalid name")
    base, i = stem, 2
    while (WORKFLOWS_DIR / f"{base}.json").exists() or (WORKFLOWS_DIR / f"{base}_api.json").exists():
        base = f"{stem}_{i}"
        i += 1

    written: list[str] = []
    if ui:
        (WORKFLOWS_DIR / f"{base}.json").write_text(ui, encoding="utf-8")
        written.append(f"{base}.json")
    if api:
        (WORKFLOWS_DIR / f"{base}_api.json").write_text(api, encoding="utf-8")
        written.append(f"{base}_api.json")
    return {"ok": True, "name": base, "files": written}


class JobSpec(BaseModel):
    board_id: str
    slots: dict[str, str]  # node_id -> file path
    attr: str | None = None


class RunRequest(BaseModel):
    workflow: str
    jobs: list[JobSpec]
    prompt_overrides: list[dict[str, Any]] | None = None


@app.post("/api/run")
async def run(req: RunRequest) -> dict[str, Any]:
    if not req.jobs:
        raise HTTPException(status_code=400, detail="no jobs")
    # validate slot paths are allowed
    for j in req.jobs:
        for p in j.slots.values():
            if not state.is_allowed(Path(p)):
                raise HTTPException(status_code=403, detail=f"path not allowed: {p}")
    try:
        results = await run_jobs(
            state.comfy,
            state.library,
            req.workflow,
            [j.model_dump() for j in req.jobs],
            prompt_overrides=req.prompt_overrides,
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"workflow": req.workflow, "results": results}


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


@app.post("/api/expand-workflow-ui")
def expand_workflow_ui(req: ExpandRequest) -> dict[str, Any]:
    """Load the original (non-API) workflow template into ComfyUI, identified
    by the shotcomfy_workflow name embedded in the PNG metadata."""
    p = Path(req.path)
    if not state.is_allowed(p):
        raise HTTPException(status_code=403, detail="path not allowed")
    if not p.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    try:
        text = dict(getattr(Image.open(p), "text", {}) or {})
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"cannot read image: {e}")
    wf_name = text.get("shotcomfy_workflow")
    if not wf_name:
        raise HTTPException(status_code=400, detail="この画像にワークフロー名が埋め込まれていません")
    ui_path = WORKFLOWS_DIR / f"{wf_name}.json"
    if not ui_path.is_file():
        raise HTTPException(status_code=404, detail=f"非APIワークフローが見つかりません: {wf_name}.json")
    wf = ui_path.read_text(encoding="utf-8")
    base = state.cfg["comfyui"]["base_url"]
    try:
        graph = json.loads(wf)
        r = httpx.post(f"{base}/shotcomfy/load", json=graph, timeout=5.0)
        if r.status_code == 200:
            return {"ok": True, "mode": "live", "name": wf_name, "comfyui_url": base}
    except Exception:  # noqa: BLE001
        pass
    install = state.cfg["comfyui"].get("install_path", "")
    wdir = Path(install) / "user" / "default" / "workflows"
    wdir.mkdir(parents=True, exist_ok=True)
    dest = wdir / f"{wf_name}.json"
    dest.write_text(wf, encoding="utf-8")
    return {"ok": True, "mode": "file", "name": wf_name, "saved": str(dest), "comfyui_url": base}


@app.post("/api/workflows/open")
def open_workflows_folder() -> dict[str, Any]:
    """Open the workflows folder in the OS file explorer."""
    try:
        subprocess.Popen(["explorer", str(WORKFLOWS_DIR)])  # explorer returns nonzero; ignore
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True, "path": str(WORKFLOWS_DIR)}


@app.post("/api/old/purge")
def purge_old(req: PathReq) -> dict[str, Any]:
    """Permanently delete every 'old/' archive folder under the given root."""
    root = Path(req.path)
    _guard(root)
    if not root.is_dir():
        raise HTTPException(status_code=404, detail="not a folder")
    olds = sorted(
        (d for d in root.rglob("old") if d.is_dir()),
        key=lambda d: len(d.parts),  # shallow first; deleting a parent removes nested ones
    )
    removed: list[str] = []
    for d in olds:
        if d.exists():
            try:
                shutil.rmtree(d)
                removed.append(str(d))
            except Exception:  # noqa: BLE001
                pass
    return {"ok": True, "removed": removed, "count": len(removed)}


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
