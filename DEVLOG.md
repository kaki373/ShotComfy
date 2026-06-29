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

Ports: frontend Vite 5273 (proxies /api → 8799), backend 8799, ComfyUI 8188 (separate).
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
— divider — 📄 複製 · ✏️ 名前を変更 · 🖼 変換[JPG|PNG] (1行/images) · 📦 フォルダへ移動 · 🗑 ゴミ箱へ削除。
- **フォルダ作成は左ツリーの右クリック**専用（`sc:treectx` → 📁 フォルダを作成 / 📂 エクスプローラ）。
- **フォルダへ移動**はフォルダツリーのモーダルピッカー（`MoveRows`）で移動先を選択。
- Backend file ops (all `state.is_allowed`-guarded): `/api/file/{duplicate,rename,convert,move,delete,restore}`,
  `/api/folder/create`. 各操作後にボード＋ツリーを更新。

### Delete model — "old/" archive (NOT the OS Recycle Bin)
⚠️ The library root can be a **network drive** (e.g. X:), which has **no Recycle Bin** — `send2trash`
there *permanently* deletes. So it was removed. Instead:
- **🗄 old に送る** (`Del` key / menu): moves the file/folder into an **`old/` subfolder of its own
  folder** (`/api/file/old` → `shutil.move` to `<parent>/old/<name>`, `_uniq` on collision). Same
  volume → instant & works on network shares, fully recoverable.
- **Ctrl/Cmd+Z**: `undoOld` → `/api/file/restore {path, src}` moves it back from `old/` to the original.
- **🗑 完全に削除…**: explicit permanent delete (`/api/file/delete` → `unlink`/`rmtree`), `window.confirm`
  first, no undo.
- Optimistic `removeNodesByPath` clears the node immediately; ReactFlow `deleteKeyCode={null}`; disabled
  while typing. Tree right-click also offers old に送る / 完全に削除 for folders.

### Undo stack + manual refresh
- **Undo** is an in-memory stack (`undoRef`): each old-に-送る pushes `{boardId, original, moved}[]`;
  `Ctrl+Z` pops the last batch and `/api/file/restore` moves each back from `old/` → original.
  Session-scoped (cleared on reload), but the files stay in `old/` for manual recovery.
- **🔄 更新** button on the canvas toolbar (`refreshAllOpen`) re-fetches all open boards in parallel and
  relayouts once — folder scans on the network drive lag, so add/duplicate/convert results can be forced
  to show on demand (delete/move already remove the node optimistically).

### More file ops + extraction + compare + persistence
- **PSD → JPG/PNG**: convert menu now shows for images **and** `.psd/.psb` (Pillow opens the PSD
  composite; png path normalizes odd modes). Backend `/api/file/convert` unchanged.
- **Video → still**: `🎬 フレーム [先頭][末尾]` extracts the first/last frame as PNG via bundled
  **ffmpeg** (`imageio-ffmpeg`, ~84MB in the venv). Backend `/api/video/frame {path, position}`
  (`-frames:v 1` for first; `-sseof -3 -update 1` for last).
- **PNG → workflow**: ComfyUI-source nodes get `🧩 ワークフローを抽出（workflowsへ）` →
  `/api/workflows/from-image` reads the PNG `workflow` (UI) + `prompt` (API) tEXt chunks and writes
  `<name>.json` + `<name>_api.json` (immediately runnable, no ComfyUI tab needed).
- **Compare fullscreen + zoom/pan**: `CompareOverlay` has a `⛶` fullscreen toggle; in fullscreen,
  **wheel = cursor-anchored zoom, drag = pan** (native listeners on the stage; transform on a
  `.cmp-zoom` wrapper). Wipe uses `clip-path` so it scales. Esc exits fullscreen.
- **Persisted toolbar settings**: genFilter/treesByTime/continuous/showTags/gridCols/gapX/gapY saved
  to `localStorage` (`shotcomfy.settings`) and restored on load (state + refs seeded from it).
- ⚠️ **Background subagents can't run tools in this environment** (Read/Edit/Bash all denied; the X:
  audit only worked because Glob happened to be allowed). Code work is done inline.

### Multi-select file ops + long-name display
- A right-click on a **selected** node acts on the **whole selection** (`menuTargets`): フォルダへ移動 /
  old に送る / 完全に削除 all show a `（N件）` count and process every selected file. Move picker handles N
  items; permanent-delete confirm shows the count.
- **Long filenames**: `smartName()` middle-truncates (`CIN…_gen3.png`) so the suffix/extension stay
  visible; `.asset-name` is 10px, 2-line clamp, break-all. Full name on hover (`title`).

### C2PA caption — hover only
`.c2pa-line` をサムネ上の絶対配置オーバーレイにし、通常は `opacity:0`、ノード hover 時のみ表示
（Gemini の "Created by google generative ai" 等が常時出ないように）。

### Output collection — save nodes only
`run_jobs` copies back only outputs from **save nodes** (`_save_node_ids`: class_type contains
`save`/`videocombine` → SaveImage, VHS_VideoCombine, SaveAnimated*, …) and `type=="output"`,
covering images/gifs/videos. PreviewImage/PreviewAny temp outputs are ignored, so a preview-only
workflow writes nothing.

---

## ComfyUI job builder (multi-file / multi-slot i2i・V2V)

Submit selected canvas images through a chosen i2i/V2V workflow. Design agreed with user:

- **Workflow formats — readable UI in, runnable API out.** The `workflows/` folder accepts both
  ComfyUI's normal export (**UI format**, `nodes[]`, human-readable) and **API format**
  (`Save (API Format)`). `list_workflows()` detects which (`is_api_graph`) and returns `api: bool`.
  - **API-format** files run directly.
  - **UI-format** files are **auto-converted in the background** (no button): `GET /api/workflows`
    schedules `_auto_convert(name)` for any UI file lacking `<name>_api.json` (dedup via
    `_converting`, non-blocking — listing returns in ~0.15s). Conversion uses **ComfyUI's own
    `graphToPrompt`** via the bridge: `comfy.convert_workflow()` POSTs the UI graph to
    `/shotcomfy/convert` → `shotcomfy.js` saves the canvas, `loadGraphData`, `graphToPrompt`, POSTs
    the API prompt to `/shotcomfy/api_result`, restores the canvas → backend polls and writes
    **`<name>_api.json`**. The UI entry is hidden once its `_api` sibling exists; the panel shows a
    small "API化中…" note + auto-polls every 4s and auto-selects the `_api` version when it appears.
    **Requires a ComfyUI restart (new bridge routes) + an open ComfyUI tab.** Glob is `*.json`;
    `load_workflow` tries `.api.json` then `.json`.
- **Slots = ComfyUI node titles.** Workflows are saved in API format (`workflows/*.api.json`)
  incl. `_meta.title`. `LoadImage` / video-loader nodes become input **slots** named by their
  title. Backend `parse_slots()` reads them, and **ordering is notation-tolerant**: a number is
  parsed from the title so `入力1` / `input1` / `Input_1` / `in 1` all sort as slot 1 (regex
  `_SLOT_NUM` then trailing-number fallback; unnumbered slots go last). Video covers VHS loaders
  incl. upload variants (`VHS_LoadVideo`, `VHS_LoadVideoUpload`, …) so video inputs also work.
- **1 job = 1 file per slot.** "入力画像が3枚 = スロット1/2/3" is exactly one job.
- **Batch = put N files in a slot.** The **first slot (入力1) is the batch axis + output-cut
  driver**: N files in 入力1 → N jobs. Secondary slots: 1 file = shared across jobs; N files =
  paired **by cut (boardId)**, else by index.
- **Output** → each job's 入力1 file's cut folder, named after the **入力1 input file** with a
  **generation-depth** suffix: `foo → foo_gen1`, `foo_gen1 → foo_gen2`（孫＝gen2）, `foo_gen2 →
  foo_gen3`. Same-generation collisions get `_2`/`_3` (`foo_gen1_2`). `_gen_output_name()` parses
  a trailing `_gen<N>` (regex `_GEN_RE`) and bumps N. No manual attr needed (field removed).
- **UI** (`components/JobBuilder.tsx`, right side panel, toggled by header ▶ ComfyUIで生成):
  workflow dropdown → **「選択を割当」**（枚数は自動）→ **ジョブ×スロットのグリッド** → 「N ジョブを投入」。
  - **枚数は自動**: 1ジョブの画像数 = そのWFの画像入力スロット数（`slotCount`）。手動入力なし。
  - **割当**: キャンバス選択を**クリック順**に slotCount 枚ずつ区切り、各かたまり=1ジョブ、k番目を
    スロットk（入力1→入力2…）へ。選択順保持のため App の `onSelectionChange` を順序維持に変更。
  - **誘導ステップ式UI（v4）**: ①キャンバス選択がパネルの「選択中」に**即サムネ表示**（番号付き・
    ライブ反映）→ **「＋ジョブに追加」**で選択をスロット数ごとに区切り**ジョブ確定**（押し損ね・
    選択消失を防ぐスナップショット方式）→ ②ジョブ一覧（#・各スロットのサムネ＋スロット名・出力先・
    個別削除・全消去）→ ③属性入力 → 「N ジョブを ComfyUI に投入」。
  - 軸(入力1=先頭スロット)が空のジョブは投入対象外。ビルダー表示中は2枚選択時の比較オーバーレイを抑止。
- **Run** (`run_jobs` + `POST /api/run`): per job, upload each slot file to ComfyUI
  (`/upload/image`), set that node's `image`/`video` input, fresh seed, `/prompt`, poll
  `/history`, download `/view`, copy into the cut folder. Per-job isolation (one failure ≠ abort).
  Path-traversal guard on every slot path (`state.is_allowed`).
- Sample slot-named workflow shipped: `workflows/i2i_sample.api.json` (LoadImage titled `入力1`).

---

## Endpoints (backend, /api)
health · config · comfyui/status · tree · lineage/{id} · boards · boards/{id} · asset?path= ·
upload · workdir · open · mode · pick-folder · reveal · expand-workflow · tags/{id} (GET/POST) ·
queue · **workflows** (GET, slot list) · **run** (POST, multi-slot jobs)

---

## Known limitations / TODO
1. ✅ Done — i2i/V2V job builder with ComfyUI image upload (see "ComfyUI job builder" above).
   Remaining: video-slot upload uses `/upload/image` (works for images; verify VHS video upload
   path on a real V2V workflow), and surface per-job progress while a batch runs.
2. ProRes .mov / 16bit / EXR can't preview in-browser (Chromium) → show placeholder; proxy
   generation (h264/webp) is a planned hard requirement.
3. Videos without C2PA (Kling, plain exports, Runway-upscaled) aren't metadata-detectable → use
   filename or manual tags.
4. New ComfyUI workflows may need a tab refresh; live-expand replaces the open graph.
5. Codex code review pending (needs Wi-Fi via the codex-wifi wrapper).
