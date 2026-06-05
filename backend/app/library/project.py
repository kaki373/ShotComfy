"""Project mode: <root>/<episode>/<cut>/ strict tree.

  root = D:/webui/Projects/XXX   (code = "XXX")
    01/                          (episode)
      001/                       (cut)
        ...materials...

Board id is "<episode>/<cut>" e.g. "01/001".
Outputs are named   <code><episode><cut>_<attr>.<ext>   e.g. XXX01001_dpt.png
"""
from __future__ import annotations

from pathlib import Path

from .base import Board, Library


def _is_numeric_dir(p: Path) -> bool:
    return p.is_dir() and p.name.isdigit()


class ProjectLibrary(Library):
    mode = "project"

    def __init__(self, root: str, code: str = "XXX") -> None:
        self.root = Path(root)
        self.code = code

    def list_boards(self) -> list[Board]:
        boards: list[Board] = []
        if not self.root.is_dir():
            return boards
        for ep in sorted(filter(_is_numeric_dir, self.root.iterdir())):
            for cut in sorted(filter(_is_numeric_dir, ep.iterdir())):
                boards.append(
                    Board(
                        id=f"{ep.name}/{cut.name}",
                        label=f"{ep.name}-{cut.name}",
                        path=str(cut),
                        episode=ep.name,
                        cut=cut.name,
                    )
                )
        return boards

    def get_board(self, board_id: str) -> Board | None:
        parts = board_id.split("/")
        if len(parts) != 2:
            return None
        ep, cut = parts
        folder = self.root / ep / cut
        if not folder.is_dir():
            return None
        b = Board(id=board_id, label=f"{ep}-{cut}", path=str(folder), episode=ep, cut=cut)
        b.assets = self._scan_assets(folder)
        return b

    def output_name(self, board_id: str, attr: str, ext: str) -> str:
        ep, cut = board_id.split("/")
        ext = ext.lstrip(".")
        stem = f"{self.code}{ep}{cut}"
        return f"{stem}_{attr}.{ext}" if attr else f"{stem}.{ext}"

    def tree(self) -> dict:
        episodes: list[dict] = []
        if self.root.is_dir():
            for ep in sorted(filter(_is_numeric_dir, self.root.iterdir())):
                cuts = [
                    {
                        "name": cut.name,
                        "path": str(cut),
                        "board_id": f"{ep.name}/{cut.name}",  # cut = openable board
                        "media": self._media_count(cut),
                        "children": [],
                    }
                    for cut in sorted(filter(_is_numeric_dir, ep.iterdir()))
                ]
                episodes.append(
                    {
                        "name": ep.name,
                        "path": str(ep),
                        "board_id": None,  # episode = container
                        "media": 0,
                        "children": cuts,
                    }
                )
        return {
            "name": self.code,
            "path": str(self.root),
            "board_id": None,
            "media": 0,
            "children": episodes,
        }
