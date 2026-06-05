# ShotComfy — Development Log / Status

Anime-production material manager: a **React Flow** canvas + **Python (FastAPI)** backend
that organizes generated/source materials per *project → episode → cut* and drives
**ComfyUI**. Separate from Obsidian (the original idea was an Obsidian plugin; switched to a
standalone app after evaluating Obsidian's Canvas-API/license/media limits and tldraw's
license — settled on React Flow, MIT).

Status: working end-to-end. Last updated 2026-06-05.

---

## Architecture

```
ShotComfy/
  frontend/            React 19 + Vite + @xyflow/react (React Flow) + dagre
    src/
      App.tsx          canvas, layout engine, all UI/state
      api.ts           typed backend client
      layout.ts        dagre tidy-tree layout (NODE_W/H, layoutConnected)
      nodes/AssetNode.tsx   the asset card (preview, badges, tints, lightbox dblclick)
      components/TreeView.tsx, CompareOverlay.tsx
  backend/             FastAPI in a venv (.venv)
    app/
      main.py          all REST endpoints + app state
      config.py        loads/saves config.json
      library/         folder→boards: base.py, free.py, project.py (build_library)
      comfyui.py       ComfyUI HTTP adapter (status/queue/history/view/upload)
      jobs.py          /api/queue orchestration (run workflow → copy outputs back)
      metadata.py      PNG/video metadata: ComfyUI prompt, source detection, C2PA, lineage
      tags.py          manual per-file tags sidecar
  workflows/           ComfyUI API-format workflow templates (txt2img_sdxl.api.json)
  comfyui_bridge/      ComfyUI custom node for live workflow load (copy into custom_nodes)
  config.json          per-PC (gitignored); copy from config.example.json
  scripts/setup.ps1, run.ps1 ; SETUP.md
```

Ports: frontend Vite 5173 (proxies /api → 8799), backend 8799, ComfyUI 8188 (separate).
Run: `scripts/run.ps1`, or backend `uvicorn app.main:app --port 8799` + frontend `npm run dev`.

---

## Two operating modes (config `mode`)
- **Free**: any single folder; subfolders form a tree; no naming rules.
- **Project**: `<root>/<episode>/<cut>/` strict tree; outputs named `XXX<ep><cut>_<attr>` (e.g. `XXX01001_dpt.png`).
Switch via the header **Free | Project** toggle (or config). 📁 button picks the folder/root
(native dialog via /api/pick-folder, or manual path) → /api/open.

---

## Sidebar = folder tree (`/api/tree`)
- Free: recursive folder tree (depth 4), every folder openable.
- Project: root → episodes (containers) → cuts (openable), with media-count badges.
- **Switch mode (default)**: clicking a folder REPLACES the canvas with that one folder.
- **「選択フォルダ全表示」 toggle**: multi-select — click folders to add/remove their
  content; selected folders show ✓ + highlight. (internal state `continuous`)

---

## Canvas & layout
- All asset nodes are a **uniform 200px** size. Double-click an image/video → **fullscreen lightbox** (Esc/click closes).
- Interaction: left-drag pan, Shift+drag box-select, right-click = context menu.
- **Lineage trees** (ComfyUI input→output chains) laid out tidily with **dagre** (parent→child
  left→right, siblings top→bottom). Default layout = standalone materials on the LEFT, trees on the RIGHT (causal).
- **「時系列で右へ」 toggle**: places trees + standalone groups on one chronological timeline (left→right by mtime).
- **Sibling grouping** (timeline): files stack vertically when they share (a) a video tool, (b)
  a numbered-variation name, (c) close creation time, or (d) the same Adobe tool (AE 1h / PS 20min sessions).
- **⚙ settings popover** (right of toolbar): sliders for コンパクト列数 (2–8, default 4),
  横間隔, 縦間隔 (0–200px). Toggles (時系列/選択フォルダ全表示/出自カラー) are always-visible in the toolbar.
- Layout changes relayout from a per-board cache (no refetch). Opening a board fitViews it.

---

## Origin / source detection & color tags
Each node gets a subtle tint + a source badge (toggle "出自カラー" to hide all). Origin =
backend metadata first, then filename. **ComfyUI is metadata-only (never by filename).**

| Source | Signal | Color/label |
|---|---|---|
| ComfyUI | PNG `prompt` text chunk | yellow / Comfy |
| Gemini (nano-banana) | SynthID or C2PA "Google Generative AI" | pink / Gemini |
| Photoshop | EXIF Software OR XMP CreatorTool = "Adobe Photoshop" (covers PNGs) | cyan / PS |
| After Effects / Premiere / AME | XMP CreatorTool near video start | indigo / AE, Pr, AME |
| Kling / Seedance | filename prefix (or Seedance C2PA model_name=dreamina-seedance) | green / teal |
| Veo (Google video) | C2PA "Google C2PA Core Generator" | (veo) |
| DALL·E / Midjourney | filename | orange / purple |
| PSD/docs | .psd/.psb/.ai/.clip listed as kind "doc" | blue-grey / PSD |
| manual | right-click → 属性を設定 (overrides everything) | custom hash color |

**C2PA Content Credentials** are parsed (`metadata.extract_c2pa`) and shown as a 🔏 caption +
tooltip (model_name, generator, description "Created by …", time, SynthID).

Gen/non-gen filter (segmented control 全表示/生成/非生成): generated = ComfyUI-meta + Gemini +
Kling/Seedance/Runway video + GPT/Gemini image name. PSD/Photoshop/AE/CG = non-generated.

---

## Manual tags (`.shotcomfy_tags.json` per folder)
Right-click a node → **OK toggle** / **属性を設定…** (Source datalist + free 日本語 labels).
Stored in a sidecar JSON in the board folder (travels with the folder). Manual source wins;
shows OK badge + label chips.

---

## ComfyUI integration
- **Drag-drop** files onto canvas → /api/upload → saved into the active folder.
- **Queue** (right-click select + "Queue selected"): /api/queue runs `workflows/txt2img_sdxl.api.json`
  (alias "default"), polls /history, downloads /view, copies output into the board folder with
  the naming convention. (Currently txt2img; i2i/Vid2V + image upload is the next TODO.)
- **🧩 ワークフローをComfyUIに展開** (ComfyUI-source images only): extracts the PNG `workflow`
  chunk and:
  1. **Live**: POST to ComfyUI `/shotcomfy/load` (the bridge) → loads into the OPEN ComfyUI tab.
  2. **Fallback**: saves to `<ComfyUI>/user/default/workflows/`.

### ComfyUI bridge (`comfyui_bridge/shotcomfy_bridge/`)
Tiny custom node, no pip deps. Copy into ComfyUI's `custom_nodes/`, restart, reload the tab.
See `comfyui_bridge/README.md`. ⚠️ Portable ComfyUI nests the code root — install under
`…\ComfyUI_windows_portable\ComfyUI\custom_nodes\` (not the outer one). Verify:
`GET /shotcomfy/ping`.

### Right-click context menu (asset nodes)
📂 エクスプローラで開く · 🧩 展開 (comfyui only) · ✓ OK · 🏷 属性を設定…

---

## Endpoints (backend, /api)
health · config · comfyui/status · tree · lineage/{id} · boards · boards/{id} · asset?path= ·
upload · workdir · open · mode · pick-folder · reveal · expand-workflow · tags/{id} (GET/POST) ·
queue

---

## Known limitations / TODO
1. Queue uses txt2img only — next: **i2i/Vid2V workflows + ComfyUI image upload** so generation
   uses the cut's actual source material; then lineage of ShotComfy's own outputs is exact.
2. ProRes .mov / 16bit / EXR can't preview in-browser (Chromium) → show placeholder; proxy
   generation (h264/webp) is a planned hard requirement.
3. Videos without C2PA (Kling, plain exports, Runway-upscaled) aren't metadata-detectable → use
   filename or manual tags.
4. New ComfyUI workflows may need a tab refresh; live-expand replaces the open graph.
5. Codex code review pending (needs Wi-Fi via the codex-wifi wrapper).
