"""Read ComfyUI provenance from PNG metadata and derive image lineage.

ComfyUI embeds two text chunks in saved PNGs:
  - "prompt"   : the API-format prompt graph (what actually ran)
  - "workflow" : the full UI graph
From "prompt" we can recover which input file(s) a generation consumed
(LoadImage / video loaders) plus key sampler params, and chain results to inputs.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from PIL import Image

from .library.base import IMAGE_EXT, VIDEO_EXT

_MEDIA_EXT = IMAGE_EXT | VIDEO_EXT

# C2PA / SynthID field names that mark the boundary after a value in the CBOR text dump
_C2PA_STOP = ("digitalsourcetype", "log_id", "parameters", "softwareagent", "version", "actions", "claim", "time", "qname", "dname")
_C2PA_GENERATORS = ("Google C2PA Core Generator Library", "BytePlus_ModelArk", "c2pa-rs")


def extract_c2pa(raw: bytes) -> dict[str, str]:
    """Best-effort pull of human-readable fields from an embedded C2PA manifest."""
    low = raw.lower()
    if b"c2pa" not in low and b"synthid" not in low:
        return {}
    txt = re.sub(rb"[^\x20-\x7e]+", b" ", raw).decode("ascii", "ignore")
    info: dict[str, str] = {}

    m = re.search(r"model_name.([\x21-\x7e]{2,60})", txt)
    if m:
        val = m.group(1)
        lo = val.lower()
        cut = len(val)
        for k in _C2PA_STOP:
            i = lo.find(k)
            if 0 < i < cut:
                cut = i - 1  # drop the 1-byte CBOR length prefix before the next key
        v = val[:cut].strip(" -_.|")
        if v:
            info["model"] = v

    d = re.search(r"(Created by [^.]{3,70}\.)", txt)
    if d:
        info["description"] = d.group(1).strip()

    for cand in _C2PA_GENERATORS:
        if cand.lower() in txt.lower():
            info["generator"] = cand
            break

    t = re.search(r"20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d", txt)
    if t:
        info["time"] = t.group(0)

    if b"synthid" in low:
        info["synthid"] = "yes"
    return info


def _string_file_inputs(node_inputs: dict[str, Any]) -> list[str]:
    """Filenames referenced as literals (not node links) in a node's inputs."""
    out: list[str] = []
    for key in ("image", "video", "audio"):
        val = node_inputs.get(key)
        if isinstance(val, str) and os.path.splitext(val)[1].lower() in _MEDIA_EXT:
            out.append(val)
    return out


def _detect_source(path: str, im: Any, has_comfy: bool) -> str:
    """Best-effort generator/origin: comfyui | gemini | photoshop | ''."""
    if has_comfy:
        return "comfyui"
    try:
        with open(path, "rb") as fh:
            raw = fh.read(262144).lower()
        # Google Gemini/Imagen embed SynthID + C2PA content credentials
        if b"synthid" in raw or (b"c2pa" in raw and b"google" in raw):
            return "gemini"
    except Exception:  # noqa: BLE001
        pass
    try:
        soft = str(im.getexif().get(305, "")).lower()
        if soft.startswith("adobe photoshop"):
            return "photoshop"
    except Exception:  # noqa: BLE001
        pass
    # PNGs from Photoshop carry the creator in XMP, not EXIF
    try:
        xmp = im.info.get("XML:com.adobe.xmp") or im.info.get("xmp") or ""
        if isinstance(xmp, bytes):
            xmp = xmp.decode("utf-8", "ignore")
        if "adobe photoshop" in xmp.lower():
            return "photoshop"
    except Exception:  # noqa: BLE001
        pass
    return ""


def read_meta(path: str) -> dict[str, Any]:
    """Return {has_comfy, inputs, params, kind, source, generated} for an image."""
    res: dict[str, Any] = {
        "has_comfy": False, "inputs": [], "params": {}, "kind": "asset",
        "source": "", "generated": False,
    }
    try:
        im = Image.open(path)
        text = dict(getattr(im, "text", {}) or {})
        if "prompt" not in text:
            text.update({k: v for k, v in im.info.items() if isinstance(v, str)})

        if "prompt" in text:
            graph = json.loads(text["prompt"])
            res["has_comfy"] = True
            inputs: list[str] = []
            sampler: dict[str, Any] = {}
            model: str | None = None
            has_video = False

            for node in graph.values():
                if not isinstance(node, dict):
                    continue
                ct = node.get("class_type", "")
                ins = node.get("inputs", {}) or {}
                for f in _string_file_inputs(ins):
                    inputs.append(f)
                    if os.path.splitext(f)[1].lower() in VIDEO_EXT:
                        has_video = True
                if ct.startswith("KSampler") and not sampler:
                    sampler = {k: ins.get(k) for k in ("seed", "steps", "denoise", "sampler_name") if k in ins}
                if ct in ("CheckpointLoaderSimple", "UNETLoader") and model is None:
                    model = ins.get("ckpt_name") or ins.get("unet_name")

            seen: list[str] = []
            for x in inputs:
                b = os.path.basename(x)
                if b not in seen:
                    seen.append(b)
            res["inputs"] = seen
            res["params"] = {"sampler": sampler, "model": model}
            res["kind"] = "vid2v" if has_video else "i2i" if seen else "txt2img"

        res["source"] = _detect_source(path, im, res["has_comfy"])
        res["generated"] = res["source"] in ("comfyui", "gemini")
        try:
            with open(path, "rb") as fh:
                c2pa = extract_c2pa(fh.read(262144))
            if c2pa:
                res["c2pa"] = c2pa
        except Exception:  # noqa: BLE001
            pass
    except Exception:  # noqa: BLE001 - metadata read is best-effort
        pass
    return res


def read_video_meta(path: str) -> dict[str, Any]:
    """Detect AI-generated video via C2PA Content Credentials / SynthID near the file
    start (e.g. Seedance/Dreamina embed urn:c2pa + model_name). Returns {source, generated}."""
    res: dict[str, Any] = {"source": "", "generated": False}
    try:
        with open(path, "rb") as fh:
            head = fh.read(262144).lower()
        if b"urn:c2pa" in head or (b"c2pa" in head and b"jumb" in head):
            res["generated"] = True
            near = head[:8192]  # tool name lives inside the manifest near the start
            if b"seedance" in head or b"dreamina" in head:
                res["source"] = "seedance"
            elif b"kling" in near:
                res["source"] = "kling"
            elif b"veo" in near:
                res["source"] = "veo"
            else:
                res["source"] = "c2pa"
        elif b"synthid" in head:
            res["generated"] = True
            res["source"] = "veo"
        # Adobe editing tools embed CreatorTool in an XMP packet near the start
        # (editing/compositing, not generation -> generated stays False)
        elif b"after effects" in head:
            res["source"] = "ae"
        elif b"adobe premiere" in head:
            res["source"] = "premiere"
        elif b"adobe media encoder" in head:
            res["source"] = "ame"
        c2pa = extract_c2pa(head)
        if c2pa:
            res["c2pa"] = c2pa
    except Exception:  # noqa: BLE001
        pass
    return res


def build_lineage(board: Any) -> dict[str, Any]:
    """Nodes + edges (input -> result) for the image assets in a board."""
    by_lower = {a.name.lower(): a.name for a in board.assets}
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []

    for a in board.assets:
        if a.kind == "image":
            meta = read_meta(a.path)
        elif a.kind == "video":
            vm = read_video_meta(a.path)
            meta = {"has_comfy": False, "inputs": [], "params": {}, "kind": a.kind,
                    "source": vm["source"], "generated": vm["generated"], "c2pa": vm.get("c2pa", {})}
        else:
            meta = {"has_comfy": False, "inputs": [], "params": {}, "kind": a.kind,
                    "source": "", "generated": False}
        nodes.append(
            {
                "name": a.name,
                "kind": meta.get("kind", a.kind),
                "has_comfy": meta.get("has_comfy", False),
                "source": meta.get("source", ""),
                "generated": meta.get("generated", False),
                "c2pa": meta.get("c2pa", {}),
                "inputs": meta.get("inputs", []),
                "params": meta.get("params", {}),
            }
        )
        for ref in meta.get("inputs", []):
            src = by_lower.get(ref.lower())
            if src and src != a.name:
                edges.append({"from": src, "to": a.name, "label": meta.get("kind", ""), "external": False})
            else:
                # input not present in this folder -> record as external reference
                edges.append({"from": ref, "to": a.name, "label": meta.get("kind", ""), "external": True})

    return {"board": board.id, "nodes": nodes, "edges": edges}
