# ShotComfy

An Obsidian-free, **React Flow** canvas + **Python** backend that drives **ComfyUI** to
generate and organize anime production materials per *project → episode → cut*.

- **Frontend**: React + Vite + [React Flow (xyflow)](https://reactflow.dev/) — MIT licensed.
- **Backend**: Python (FastAPI) in a virtual environment. Talks to ComfyUI's HTTP API,
  copies outputs back into the relevant folder, and applies the `XXX01001_<attr>` naming.

## Two modes

| Mode | Target | Naming | Use |
|------|--------|--------|-----|
| **Free** | any single folder | none | quick / one-off experiments |
| **Project** | `<Project>/<episode>/<cut>/` strict tree | `XXX01001_<attr>` enforced | production pipeline |

Both modes share the same canvas, the same ComfyUI adapter, and the same queue flow.
Only the *library layer* (how materials are discovered) differs.

## What it does
- Folder tree sidebar; switch one folder or multi-select several ("選択フォルダ全表示").
- Canvas of uniform asset cards; double-click → fullscreen; right-click → menu.
- **Lineage**: reads ComfyUI PNG metadata to chain input→output, laid out as tidy dagre trees.
- **Origin color tags**: ComfyUI / Gemini / Photoshop / After Effects / Kling / Seedance / Veo /
  DALL·E / Midjourney, detected from metadata (incl. C2PA Content Credentials & SynthID), plus
  manual per-file tags (Source / OK / labels) saved beside the files.
- Timeline / sibling-grouping layouts; ⚙ popover for column count + node spacing.
- **ComfyUI**: drag-drop upload, queue a workflow (output copied back + named), and
  **🧩 expand a ComfyUI image's workflow into the open ComfyUI editor** (via the bundled bridge).

Full feature/architecture notes: **[DEVLOG.md](./DEVLOG.md)**.

## Layout

```
ShotComfy/
  frontend/            # React + Vite + React Flow
  backend/             # Python FastAPI (venv)
    app/
      comfyui.py       # ComfyUI HTTP adapter (queue -> fetch output)
      library/         # Free / Project library implementations
  config.example.json  # copy to config.json and edit
  SETUP.md             # per-PC install steps
```

See [SETUP.md](./SETUP.md) to install on this or another PC.
