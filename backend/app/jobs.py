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
    path = WORKFLOWS_DIR / f"{stem}.api.json"
    if not path.exists():
        raise FileNotFoundError(f"workflow template not found: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


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


async def _wait_history(comfy: ComfyUI, prompt_id: str, timeout: float, interval: float) -> dict | None:
    start = time.monotonic()
    while time.monotonic() - start < timeout:
        hist = await comfy.history(prompt_id)
        if prompt_id in hist:
            return hist[prompt_id]
        await asyncio.sleep(interval)
    return None


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
