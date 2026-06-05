"""Manual per-file tags, stored in a sidecar JSON inside each board folder.

`.shotcomfy_tags.json` shape:
    { "<filename>": { "source": "RunwayUpscale", "ok": true, "labels": ["bg", "修正"] } }

Used for files whose origin/state can't be detected from metadata (e.g. a
Runway-upscaled clip that lost its C2PA). Manual source overrides auto-detection.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

FILENAME = ".shotcomfy_tags.json"


def _path(folder: str) -> Path:
    return Path(folder) / FILENAME


def load_tags(folder: str) -> dict[str, Any]:
    p = _path(folder)
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            return {}
    return {}


def set_tag(folder: str, name: str, patch: dict[str, Any]) -> dict[str, Any]:
    """Merge `patch` into the file's tag entry; empty values clear that key."""
    data = load_tags(folder)
    entry = dict(data.get(name, {}))
    entry.update(patch)
    # drop empty/false values so the file stays clean (absence == not set)
    entry = {k: v for k, v in entry.items() if v not in (None, "", [], False)}
    if entry:
        data[name] = entry
    else:
        data.pop(name, None)
    _path(folder).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return data.get(name, {})
