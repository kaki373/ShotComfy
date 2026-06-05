"""Free mode: one arbitrary folder.

The folder itself is a single board; each immediate sub-folder is also a board
so you can keep a few groups side by side. No naming rules are enforced.
"""
from __future__ import annotations

from pathlib import Path

from .base import Board, Library


class FreeLibrary(Library):
    mode = "free"

    def __init__(self, folder: str) -> None:
        self.root = Path(folder)

    def _board_for(self, folder: Path) -> Board:
        rel = "." if folder == self.root else folder.name
        return Board(id=rel, label=folder.name or str(folder), path=str(folder))

    def list_boards(self) -> list[Board]:
        boards: list[Board] = []
        if not self.root.is_dir():
            return boards
        boards.append(self._board_for(self.root))
        for p in sorted(self.root.iterdir()):
            if p.is_dir():
                boards.append(self._board_for(p))
        return boards

    def get_board(self, board_id: str) -> Board | None:
        folder = self.root if board_id == "." else (self.root / board_id)
        if not folder.is_dir():
            return None
        b = self._board_for(folder)
        b.assets = self._scan_assets(folder)
        return b

    def output_name(self, board_id: str, attr: str, ext: str) -> str:
        # free mode keeps the ComfyUI-given stem, just tags the attribute
        ext = ext.lstrip(".")
        return f"{attr}.{ext}" if attr else f"output.{ext}"

    def tree(self, max_depth: int = 4) -> dict:
        def walk(folder: Path, rel: str, depth: int) -> dict:
            children: list[dict] = []
            if depth < max_depth and folder.is_dir():
                for p in sorted(folder.iterdir()):
                    if p.is_dir():
                        crel = p.name if rel == "." else f"{rel}/{p.name}"
                        children.append(walk(p, crel, depth + 1))
            return {
                "name": folder.name or str(folder),
                "path": str(folder),
                "board_id": rel,  # every folder is openable in free mode
                "media": self._media_count(folder),
                "children": children,
            }

        return walk(self.root, ".", 0)
