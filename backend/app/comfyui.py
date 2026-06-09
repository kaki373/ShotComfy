"""Minimal ComfyUI HTTP adapter.

Wraps the handful of ComfyUI endpoints ShotComfy needs:
  - GET  /system_stats      -> health / liveness
  - POST /prompt            -> enqueue a workflow (prompt graph)
  - GET  /history/{id}      -> fetch results for a finished prompt
  - GET  /view?...          -> download a generated file

This is intentionally thin; workflow building lives elsewhere.
"""
from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any

import httpx


class ComfyUI:
    def __init__(self, base_url: str, timeout: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/")
        self._timeout = timeout

    async def status(self) -> dict[str, Any]:
        """Return system_stats, or {'online': False} if unreachable."""
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as c:
                r = await c.get(f"{self.base_url}/system_stats")
                r.raise_for_status()
                data = r.json()
                data["online"] = True
                return data
        except Exception as e:  # noqa: BLE001 - liveness probe, any error == offline
            return {"online": False, "error": str(e)}

    async def queue_prompt(self, prompt: dict[str, Any], client_id: str | None = None) -> dict[str, Any]:
        """Submit a workflow graph (API-format prompt). Returns {'prompt_id': ...}."""
        payload: dict[str, Any] = {"prompt": prompt}
        if client_id:
            payload["client_id"] = client_id
        async with httpx.AsyncClient(timeout=self._timeout) as c:
            r = await c.post(f"{self.base_url}/prompt", json=payload)
            r.raise_for_status()
            return r.json()

    async def history(self, prompt_id: str) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=self._timeout) as c:
            r = await c.get(f"{self.base_url}/history/{prompt_id}")
            r.raise_for_status()
            return r.json()

    async def view_bytes(self, filename: str, subfolder: str = "", type_: str = "output") -> bytes:
        params = {"filename": filename, "subfolder": subfolder, "type": type_}
        async with httpx.AsyncClient(timeout=self._timeout) as c:
            r = await c.get(f"{self.base_url}/view", params=params)
            r.raise_for_status()
            return r.content

    async def convert_workflow(self, graph: dict[str, Any], timeout: float = 18.0) -> dict[str, Any]:
        """Convert a UI-format workflow to API format using the open ComfyUI tab's
        own graphToPrompt (via the ShotComfy bridge). Returns {"prompt": {...}} or
        {"error": "..."}. Requires the bridge custom node + an open ComfyUI tab."""
        rid = uuid.uuid4().hex
        try:
            async with httpx.AsyncClient(timeout=10.0) as c:
                r = await c.post(f"{self.base_url}/shotcomfy/convert", json={"id": rid, "graph": graph})
                if r.status_code in (404, 405):
                    return {"error": "変換ブリッジ未ロード：ComfyUIを再起動してください"}
                r.raise_for_status()
                start = time.monotonic()
                while time.monotonic() - start < timeout:
                    await asyncio.sleep(0.5)
                    rr = await c.get(f"{self.base_url}/shotcomfy/api_result", params={"id": rid})
                    if rr.status_code != 200:
                        continue
                    data = rr.json()
                    if data.get("pending"):
                        continue
                    return data  # {"prompt": ...} or {"error": ...}
        except httpx.HTTPError as e:
            return {"error": f"ComfyUI unreachable: {e}"}
        return {"error": "timeout: ComfyUIタブが開いていない/ブリッジ未ロードの可能性"}

    async def upload_image(self, data: bytes, filename: str, overwrite: bool = True) -> dict[str, Any]:
        """Upload a file into ComfyUI's input dir. Returns {name, subfolder, type}."""
        files = {"image": (filename, data, "application/octet-stream")}
        form = {"overwrite": "true" if overwrite else "false"}
        async with httpx.AsyncClient(timeout=self._timeout) as c:
            r = await c.post(f"{self.base_url}/upload/image", files=files, data=form)
            r.raise_for_status()
            return r.json()
