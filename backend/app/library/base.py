"""Shared types and interface for the library layer."""
from __future__ import annotations

import abc
from dataclasses import dataclass, field
from pathlib import Path

# What ShotComfy treats as previewable media. ProRes .mov / 16bit / .exr are
# listed but the frontend can only *play* h264-ish files; the rest need proxies.
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".exr"}
VIDEO_EXT = {".mp4", ".mov", ".webm", ".m4v"}
# editable source docs (Photoshop etc.) — listed so they group with same-period images
DOC_EXT = {".psd", ".psb", ".ai", ".clip", ".xcf", ".kra"}
MEDIA_EXT = IMAGE_EXT | VIDEO_EXT | DOC_EXT


def kind_of(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in IMAGE_EXT:
        return "image"
    if ext in VIDEO_EXT:
        return "video"
    if ext in DOC_EXT:
        return "doc"
    return "other"


@dataclass
class Asset:
    name: str
    path: str          # absolute path on disk
    kind: str          # "image" | "video" | "other"
    size: int = 0
    mtime: float = 0.0


@dataclass
class Board:
    """A unit shown as one canvas. A cut (project mode) or a folder (free mode)."""
    id: str            # "01/001" (project) or folder name (free)
    label: str
    path: str          # absolute folder path
    episode: str | None = None
    cut: str | None = None
    assets: list[Asset] = field(default_factory=list)


class Library(abc.ABC):
    mode: str = "base"

    @abc.abstractmethod
    def list_boards(self) -> list[Board]:
        """All boards (without assets loaded), cheap."""

    @abc.abstractmethod
    def get_board(self, board_id: str) -> Board | None:
        """One board with its assets loaded."""

    @abc.abstractmethod
    def output_name(self, board_id: str, attr: str, ext: str) -> str:
        """Filename a generated output should take when copied into the board."""

    @abc.abstractmethod
    def tree(self) -> dict:
        """Nested folder tree for the sidebar.

        Node shape: {name, path, board_id|None, media:int, children:[...]}.
        board_id is set when the folder can be opened as a board; None = container.
        """

    @staticmethod
    def _media_count(folder: Path) -> int:
        if not folder.is_dir():
            return 0
        return sum(1 for p in folder.iterdir() if p.is_file() and p.suffix.lower() in MEDIA_EXT)

    # ---- shared helpers ----------------------------------------------------
    @staticmethod
    def _scan_assets(folder: Path) -> list[Asset]:
        out: list[Asset] = []
        if not folder.is_dir():
            return out
        for p in sorted(folder.iterdir()):
            if p.is_file() and p.suffix.lower() in MEDIA_EXT:
                st = p.stat()
                out.append(
                    Asset(name=p.name, path=str(p), kind=kind_of(p),
                          size=st.st_size, mtime=st.st_mtime)
                )
        return out
