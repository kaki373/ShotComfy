# ShotComfy — Setup

Works on this PC and any other (copy/clone the repo). ComfyUI is **separate** and must
be running already (default `http://127.0.0.1:8188`).

## Prerequisites
- **Python 3.11+** on PATH
- **Node.js 18+** (with npm)
- A running **ComfyUI** instance

## 1. Config
Copy the example config and edit paths for this machine:

```powershell
Copy-Item config.example.json config.json
```

Edit `config.json`:
- `comfyui.base_url` — your ComfyUI URL (default `http://127.0.0.1:8188`)
- `comfyui.install_path` / `output_dir` — where ComfyUI lives / writes
- `mode` — `"free"` (any folder) or `"project"` (Project/episode/cut tree)
- `free.folder` — the folder to open in free mode
- `project.root` / `project.code` — project root + code (e.g. `XXX`) for project mode

`config.json` is gitignored (per-machine).

## 2. One-shot setup (recommended)
```powershell
.\scripts\setup.ps1
```
This creates the Python venv, installs backend + frontend deps, and copies the config.

### …or manual setup
Backend:
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```
Frontend:
```powershell
cd frontend
npm install
```

## 3. Run
```powershell
.\scripts\run.ps1
```
Or run each part manually:

Backend (from `backend`, venv active):
```powershell
uvicorn app.main:app --host 127.0.0.1 --port 8799 --reload
```
Frontend (from `frontend`):
```powershell
npm run dev
```

Open the app: **http://localhost:5273**
(The Vite dev server proxies `/api` to the backend on `:8799`.)

## Optional: ComfyUI bridge (live workflow expand)
To make "🧩 ワークフローをComfyUIに展開" load into the open ComfyUI editor, copy
`comfyui_bridge/shotcomfy_bridge/` into ComfyUI's `custom_nodes/` and restart ComfyUI.
See [comfyui_bridge/README.md](./comfyui_bridge/README.md). Without it, ShotComfy
falls back to saving the workflow into ComfyUI's `user/default/workflows/`.

## Ports
| Service | Port |
|---------|------|
| Frontend (Vite) | 5273 |
| Backend (FastAPI) | 8799 |
| ComfyUI (separate) | 8188 |
