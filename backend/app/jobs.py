"""Queue orchestration: take board(s) + a workflow, run it on ComfyUI, and copy
the resulting outputs back into each board folder with ShotComfy naming.

Round trip per board:
  build graph -> POST /prompt -> poll /history -> download /view -> write into board
"""
from __future__ import annotations

import asyncio
import copy
import json
import random
import re
import time
from pathlib import Path
from typing import Any

from .comfyui import ComfyUI
from .config import REPO_ROOT
from .library import Library

WORKFLOWS_DIR = REPO_ROOT / "workflows"

# friendly name -> template file stem
ALIASES = {"default": "txt2img_sdxl"}

# node ids in the bundled txt2img template (kept here so overrides are explicit)
NODE_POS = "6"
NODE_NEG = "7"
NODE_SAMPLER = "3"
NODE_LATENT = "5"
NODE_CKPT = "4"


def load_workflow(name: str) -> dict[str, Any]:
    stem = ALIASES.get(name, name)
    for cand in (WORKFLOWS_DIR / f"{stem}.api.json", WORKFLOWS_DIR / f"{stem}.json"):
        if cand.exists():
            return json.loads(cand.read_text(encoding="utf-8"))
    raise FileNotFoundError(f"workflow template not found: {stem}(.api).json")


def apply_params(graph: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
    """Best-effort overrides for the bundled txt2img template. Missing nodes are
    skipped so a custom workflow won't crash if ids differ."""
    def setin(node: str, key: str, val: Any) -> None:
        if node in graph and "inputs" in graph[node]:
            graph[node]["inputs"][key] = val

    if "prompt" in params:
        setin(NODE_POS, "text", params["prompt"])
    if "negative" in params:
        setin(NODE_NEG, "text", params["negative"])
    setin(NODE_SAMPLER, "seed", int(params.get("seed", random.randint(0, 2**31 - 1))))
    if "steps" in params:
        setin(NODE_SAMPLER, "steps", int(params["steps"]))
    if "width" in params:
        setin(NODE_LATENT, "width", int(params["width"]))
    if "height" in params:
        setin(NODE_LATENT, "height", int(params["height"]))
    if "ckpt" in params:
        setin(NODE_CKPT, "ckpt_name", params["ckpt"])
    return graph


def _collect_images(hist: dict[str, Any]) -> list[dict[str, Any]]:
    images: list[dict[str, Any]] = []
    for node_out in hist.get("outputs", {}).values():
        images.extend(node_out.get("images", []))
    return images


# nodes that actually save a file (vs PreviewImage/PreviewAny which write to temp)
_SAVE_HINTS = ("save", "videocombine")


def _save_node_ids(graph: dict[str, Any]) -> set[str]:
    return {
        nid
        for nid, n in graph.items()
        if isinstance(n, dict) and any(h in str(n.get("class_type", "")).lower() for h in _SAVE_HINTS)
    }


def _collect_saved(hist: dict[str, Any], save_ids: set[str]) -> list[dict[str, Any]]:
    """Output files from SAVE nodes only (SaveImage / VHS_VideoCombine / …), skipping
    temp previews. Covers images, gifs and videos."""
    out: list[dict[str, Any]] = []
    for nid, node_out in hist.get("outputs", {}).items():
        if save_ids and nid not in save_ids:
            continue
        for key in ("images", "gifs", "videos"):
            for item in node_out.get(key, []):
                if item.get("type", "output") == "output":  # exclude temp previews
                    out.append(item)
    return out


async def _wait_history(comfy: ComfyUI, prompt_id: str, timeout: float, interval: float) -> dict | None:
    start = time.monotonic()
    while time.monotonic() - start < timeout:
        hist = await comfy.history(prompt_id)
        if prompt_id in hist:
            return hist[prompt_id]
        await asyncio.sleep(interval)
    return None


def _slot_kind(class_type: str) -> str | None:
    """image / video input loaders. Video covers VHS_LoadVideo and upload variants."""
    ct = class_type.lower()
    if "loadimage" in ct:
        return "image"
    if "loadvideo" in ct or "uploadvideo" in ct or ("video" in ct and ("load" in ct or "upload" in ct or "vhs" in ct)):
        return "video"
    return None


# slot index from a title, notation-tolerant: 入力1 / input1 / Input_1 / in 2 / image-3 …
_SLOT_NUM = re.compile(r"(?:入力|input|in|img|image)\s*[_\-\s]*(\d+)", re.IGNORECASE)
_TRAIL_NUM = re.compile(r"(\d+)\s*$")


def _slot_index(title: str) -> int | None:
    m = _SLOT_NUM.search(title) or _TRAIL_NUM.search(title)
    return int(m.group(1)) if m else None


def _slot_sort_key(s: dict[str, Any]) -> tuple[int, int, str]:
    idx = _slot_index(str(s["title"]))
    # numbered slots first (by number), then the rest by node id
    return (0, idx, str(s["node_id"])) if idx is not None else (1, 0, str(s["node_id"]))


def parse_slots(graph: dict[str, Any]) -> list[dict[str, Any]]:
    """Image/video input slots of a workflow: LoadImage / video-loader nodes, named by
    their ComfyUI node title (_meta.title). Ordering is by a number parsed from the title
    so 入力1 / input1 / Input_1 all become slot 1 regardless of notation."""
    slots: list[dict[str, Any]] = []
    for nid, node in graph.items():
        if not isinstance(node, dict):
            continue
        kind = _slot_kind(node.get("class_type", ""))
        if not kind:
            continue
        title = (node.get("_meta") or {}).get("title") or f"{node.get('class_type')} {nid}"
        slots.append({"node_id": nid, "title": title, "kind": kind})
    slots.sort(key=_slot_sort_key)
    return slots


def _wf_name(p: Path) -> str:
    return p.name[: -len(".api.json")] if p.name.endswith(".api.json") else p.stem


def is_api_graph(graph: Any) -> bool:
    """API format = dict of nodes keyed by id, each with a class_type."""
    return isinstance(graph, dict) and any(
        isinstance(v, dict) and "class_type" in v for v in graph.values()
    )


def _ui_slots(graph: dict[str, Any]) -> list[dict[str, Any]]:
    """Input slots from a UI-format workflow (nodes[] with type + title)."""
    slots: list[dict[str, Any]] = []
    for node in graph.get("nodes", []):
        if not isinstance(node, dict):
            continue
        kind = _slot_kind(node.get("type", ""))
        if not kind:
            continue
        title = node.get("title") or node.get("type") or str(node.get("id"))
        slots.append({"node_id": str(node.get("id")), "title": title, "kind": kind})
    slots.sort(key=_slot_sort_key)
    return slots


def ui_sources_needing_convert() -> list[str]:
    """UI-format workflow names whose <name>_api.json cache is missing or older than
    the source (so editing+re-saving a UI workflow re-converts automatically)."""
    out: list[str] = []
    if not WORKFLOWS_DIR.is_dir():
        return out
    for p in WORKFLOWS_DIR.glob("*.json"):
        name = _wf_name(p)
        if name.endswith("_api"):  # this is a cache, not a source
            continue
        try:
            graph = json.loads(p.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        if is_api_graph(graph) or not (isinstance(graph, dict) and isinstance(graph.get("nodes"), list)):
            continue  # already API, or not a workflow
        cache = WORKFLOWS_DIR / f"{name}_api.json"
        if not cache.exists() or p.stat().st_mtime > cache.stat().st_mtime + 1:
            out.append(name)
    return out


def list_workflows() -> list[dict[str, Any]]:
    """All *.json in the workflows dir. API-format files are runnable (api=True);
    UI-format files are listed with api=False so they can be converted on demand.
    An API cache (<name>.api.json) wins over a UI file with the same name."""
    by_name: dict[str, dict[str, Any]] = {}
    if not WORKFLOWS_DIR.is_dir():
        return []
    for p in sorted(WORKFLOWS_DIR.glob("*.json")):
        name = _wf_name(p)
        try:
            graph = json.loads(p.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        if is_api_graph(graph):
            info = {"name": name, "slots": parse_slots(graph), "api": True}
        elif isinstance(graph, dict) and isinstance(graph.get("nodes"), list):
            # hide a UI-format file once its auto-converted <name>_api.json exists
            if (WORKFLOWS_DIR / f"{name}_api.json").exists():
                continue
            info = {"name": name, "slots": _ui_slots(graph), "api": False}
        else:
            continue
        # prefer an API-format entry over a UI one of the same name
        if name not in by_name or (info["api"] and not by_name[name]["api"]):
            by_name[name] = info
    return list(by_name.values())


# trailing "_gen<N>" (optionally with a "_<dup>" disambiguator) on a stem
_GEN_RE = re.compile(r"_gen(\d+)(?:_\d+)?$", re.IGNORECASE)


def _gen_output_name(folder: Path, input_stem: str, ext: str) -> str:
    """Name an output after its input file, bumping the generation number by depth:
    foo -> foo_gen1, foo_gen1 -> foo_gen2, foo_gen2 -> foo_gen3. Same-generation
    collisions get a _2/_3 suffix (e.g. foo_gen1_2)."""
    m = _GEN_RE.search(input_stem)
    if m:
        base, gen = input_stem[: m.start()], int(m.group(1)) + 1
    else:
        base, gen = input_stem, 1
    cand = f"{base}_gen{gen}{ext}"
    if not (folder / cand).exists():
        return cand
    k = 2
    while (folder / f"{base}_gen{gen}_{k}{ext}").exists():
        k += 1
    return f"{base}_gen{gen}_{k}{ext}"


async def run_jobs(
    comfy: ComfyUI,
    library: Library,
    workflow_name: str,
    jobs: list[dict[str, Any]],
    timeout: float = 300.0,
) -> list[dict[str, Any]]:
    """Run N jobs. Each job = {board_id, slots:{node_id: file_path}}.
    Uploads each slot file to ComfyUI, sets that LoadImage/video node's input,
    submits, then copies outputs into the board (cut) folder. Output files are named
    after the primary (入力1) input file with a generation-depth _gen<N> suffix."""
    base = load_workflow(workflow_name)
    slot_order = parse_slots(base)
    primary_node = slot_order[0]["node_id"] if slot_order else None
    save_ids = _save_node_ids(base)  # only copy outputs from real save nodes
    results: list[dict[str, Any]] = []
    for job in jobs:
        try:
            board_id = job["board_id"]
            slots: dict[str, str] = job.get("slots", {})
            board = library.get_board(board_id)
            if board is None:
                results.append({"board": board_id, "error": "board not found"})
                continue

            graph = copy.deepcopy(base)
            for node_id, path in slots.items():
                node = graph.get(node_id)
                if not isinstance(node, dict):
                    continue
                up = await comfy.upload_image(Path(path).read_bytes(), Path(path).name)
                name = up.get("name", Path(path).name)
                sub = up.get("subfolder", "")
                ref = f"{sub}/{name}" if sub else name
                ins = node.setdefault("inputs", {})
                ins["video" if _slot_kind(node.get("class_type", "")) == "video" else "image"] = ref

            apply_params(graph, {})  # fresh random seed
            submit = await comfy.queue_prompt(graph)
            prompt_id = submit.get("prompt_id")
            if not prompt_id:
                results.append({"board": board_id, "error": "submit failed", "detail": submit})
                continue
            if submit.get("node_errors"):
                results.append({"board": board_id, "prompt_id": prompt_id, "error": "node_errors", "detail": submit["node_errors"]})
                continue

            hist = await _wait_history(comfy, prompt_id, timeout=timeout, interval=1.5)
            if hist is None:
                results.append({"board": board_id, "prompt_id": prompt_id, "error": "timeout"})
                continue
            # name outputs after the primary (入力1) input file, with _gen<depth>
            in_path = slots.get(primary_node) if primary_node else None
            stem = Path(in_path).stem if in_path else workflow_name
            images = _collect_saved(hist, save_ids)
            copied: list[str] = []
            for img in images:
                data = await comfy.view_bytes(img["filename"], img.get("subfolder", ""), img.get("type", "output"))
                ext = Path(img["filename"]).suffix
                # write sequentially so the next image picks the following _gen number
                name = _gen_output_name(Path(board.path), stem, ext)
                dest = Path(board.path) / name
                dest.write_bytes(data)
                copied.append(str(dest))
            results.append({"board": board_id, "prompt_id": prompt_id, "outputs": copied})
        except Exception as e:  # noqa: BLE001 - isolate per job
            results.append({"board": job.get("board_id"), "error": str(e)})
    return results


async def run_queue(
    comfy: ComfyUI,
    library: Library,
    board_ids: list[str],
    workflow: str | dict[str, Any],
    params: dict[str, Any],
    timeout: float = 240.0,
) -> list[dict[str, Any]]:
    base = workflow if isinstance(workflow, dict) else load_workflow(workflow)
    attr = str(params.get("attr", "gen"))
    results: list[dict[str, Any]] = []

    for bid in board_ids:
        # isolate each board: one bad cut must not abort the whole batch
        try:
            board = library.get_board(bid)
            if board is None:
                results.append({"board": bid, "error": "board not found"})
                continue

            graph = apply_params(copy.deepcopy(base), params)
            submit = await comfy.queue_prompt(graph)
            prompt_id = submit.get("prompt_id")
            node_errors = submit.get("node_errors") or {}
            if not prompt_id:
                results.append({"board": bid, "error": "submit failed", "detail": submit})
                continue
            if node_errors:
                results.append({"board": bid, "prompt_id": prompt_id, "error": "node_errors", "detail": node_errors})
                continue

            hist = await _wait_history(comfy, prompt_id, timeout=timeout, interval=1.5)
            if hist is None:
                results.append({"board": bid, "prompt_id": prompt_id, "error": "timeout"})
                continue

            images = _collect_images(hist)
            copied: list[str] = []
            for i, img in enumerate(images):
                data = await comfy.view_bytes(
                    img["filename"], img.get("subfolder", ""), img.get("type", "output")
                )
                ext = Path(img["filename"]).suffix
                a = attr if len(images) == 1 else f"{attr}{i + 1}"
                dest = Path(board.path) / library.output_name(bid, a, ext)
                dest.write_bytes(data)
                copied.append(str(dest))

            results.append({"board": bid, "prompt_id": prompt_id, "outputs": copied})
        except Exception as e:  # noqa: BLE001 - per-board isolation, report and continue
            results.append({"board": bid, "error": str(e)})

    return results
