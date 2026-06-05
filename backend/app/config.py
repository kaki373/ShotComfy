"""Loads ShotComfy config.json (falls back to config.example.json).

The config file lives at the repo root: D:/webui/ShotComfy/config.json
Copy config.example.json -> config.json on each PC and edit paths there.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

# repo root = two levels up from this file (backend/app/config.py -> repo root)
REPO_ROOT = Path(__file__).resolve().parents[2]


def _config_path() -> Path:
    real = REPO_ROOT / "config.json"
    if real.exists():
        return real
    return REPO_ROOT / "config.example.json"


def load_config() -> dict[str, Any]:
    path = _config_path()
    with path.open("r", encoding="utf-8") as f:
        cfg = json.load(f)
    cfg["_source"] = str(path)
    return cfg


def save_config(cfg: dict[str, Any]) -> Path:
    """Persist config to <repo>/config.json (dropping internal _ keys)."""
    out = {k: v for k, v in cfg.items() if not k.startswith("_")}
    path = REPO_ROOT / "config.json"
    path.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    return path
