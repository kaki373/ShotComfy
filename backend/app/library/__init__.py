"""Library layer: discovers boards & assets on disk.

Two implementations share one interface so the canvas / ComfyUI code is
mode-agnostic:
  - FreeLibrary    : any single folder
  - ProjectLibrary : <Project>/<episode>/<cut>/ strict tree
"""
from .base import Asset, Board, Library
from .free import FreeLibrary
from .project import ProjectLibrary


def build_library(cfg: dict) -> Library:
    mode = cfg.get("mode", "free")
    if mode == "project":
        p = cfg["project"]
        return ProjectLibrary(root=p["root"], code=p.get("code", "XXX"))
    f = cfg["free"]
    return FreeLibrary(folder=f["folder"])


__all__ = ["Asset", "Board", "Library", "FreeLibrary", "ProjectLibrary", "build_library"]
