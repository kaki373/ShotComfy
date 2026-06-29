// Typed client for the ShotComfy backend (FastAPI on :8799, proxied via /api).

export interface BoardSummary {
  id: string;
  label: string;
  episode: string | null;
  cut: string | null;
  path: string;
}

export interface AssetT {
  name: string;
  path: string;
  kind: "image" | "video" | "doc" | "other";
  size: number;
  mtime: number;
}

export interface BoardDetail extends BoardSummary {
  assets: AssetT[];
}

export interface ConfigT {
  mode: "free" | "project";
  comfyui_url: string;
  target: Record<string, unknown>;
}

export interface ComfyStatus {
  online: boolean;
  error?: string;
  [k: string]: unknown;
}

export interface QueueResult {
  board: string;
  prompt_id?: string;
  outputs?: string[];
  error?: string;
  detail?: unknown;
}
export interface QueueResp {
  workflow: string;
  results: QueueResult[];
}

async function json<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return (await r.json()) as T;
}

export const getConfig = () => fetch("/api/config").then(json<ConfigT>);
export const getComfyStatus = () => fetch("/api/comfyui/status").then(json<ComfyStatus>);
export const getBoards = () => fetch("/api/boards").then(json<BoardSummary[]>);
// board id may contain "/" (e.g. "01/001"); the backend route is a path param.
export const getBoard = (id: string) => fetch(`/api/boards/${id}`).then(json<BoardDetail>);

export const assetUrl = (path: string) => `/api/asset?path=${encodeURIComponent(path)}`;

export const queueBoards = (board_ids: string[], workflow = "default") =>
  fetch("/api/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ board_ids, workflow }),
  }).then(json<QueueResp>);

export interface WorkflowSlot {
  node_id: string;
  title: string;
  kind: "image" | "video";
}
export interface PromptSlot {
  node_id: string;
  field: string;
  role: "positive" | "negative";
  title: string;
  text: string;  // preview of current text
  connected: boolean;  // true = text comes from another node (e.g. LLM)
  source?: { node_id: string; class_type: string };
}
export interface WorkflowInfo {
  name: string;
  slots: WorkflowSlot[];
  prompt_slots: PromptSlot[];
  api: boolean; // true = runnable API format; false = UI format, needs conversion
}
export const getWorkflows = () => fetch("/api/workflows").then(json<WorkflowInfo[]>);

export const openWorkflowsFolder = () =>
  fetch("/api/workflows/open", { method: "POST" }).then(json<{ ok: boolean; path: string }>);

export const purgeOld = (path: string) =>
  fetch("/api/old/purge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  }).then(json<{ ok: boolean; removed: string[]; count: number }>);

export const convertWorkflow = (name: string) =>
  fetch("/api/workflows/convert", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  }).then(json<{ ok: boolean; name: string; slots: WorkflowSlot[] }>);

export interface JobSpec {
  board_id: string;
  slots: Record<string, string>; // node_id -> file path
  attr?: string;
}
export interface PromptOverride {
  node_id: string;
  mode: "prepend" | "append" | "replace";
  text: string;
  override_connection?: boolean;
}
export const runJobs = (workflow: string, jobs: JobSpec[], prompt_overrides?: PromptOverride[]) =>
  fetch("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workflow, jobs, prompt_overrides }),
  }).then(json<QueueResp>);

export interface SavedAsset {
  name: string;
  path: string;
  kind: AssetT["kind"];
}
export const uploadFiles = (boardId: string, files: File[]) => {
  const fd = new FormData();
  fd.append("board_id", boardId);
  for (const f of files) fd.append("files", f);
  return fetch("/api/upload", { method: "POST", body: fd }).then(
    json<{ board: string; saved: SavedAsset[] }>,
  );
};

export const setWorkdir = (folder: string) =>
  fetch("/api/workdir", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder }),
  }).then(json<{ mode: string; folder: string; boards: BoardSummary[] }>);

export const pickFolder = () =>
  fetch("/api/pick-folder").then(json<{ folder: string | null; error?: string }>);

export interface TreeNode {
  name: string;
  path: string;
  board_id: string | null; // openable as a board when non-null
  media: number;
  children: TreeNode[];
}
export const getTree = () => fetch("/api/tree").then(json<TreeNode>);

interface OpenResp {
  mode: string;
  target: Record<string, unknown>;
  tree: TreeNode;
}
// open a folder as the root for the given mode (default: current mode)
export const openFolder = (folder: string, mode?: "free" | "project", code?: string) =>
  fetch("/api/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder, mode, code }),
  }).then(json<OpenResp>);

export const setMode = (mode: "free" | "project") =>
  fetch("/api/mode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  }).then(json<OpenResp>);

export interface LineageNode {
  name: string;
  kind: string; // txt2img | i2i | vid2v | asset
  has_comfy: boolean;
  source: string; // comfyui | gemini | photoshop | ""
  generated: boolean;
  c2pa?: Record<string, string>; // extracted Content Credentials fields
  inputs: string[];
  params: Record<string, unknown>;
  workflow?: string; // ShotComfy workflow template name embedded in PNG
}
export interface LineageEdge {
  from: string;
  to: string;
  label: string;
  external: boolean;
}
export interface Lineage {
  board: string;
  nodes: LineageNode[];
  edges: LineageEdge[];
}
export const getLineage = (id: string) => fetch(`/api/lineage/${id}`).then(json<Lineage>);

// ---- file operations (right-click menu) ----
interface FileOpResp {
  ok: boolean;
  path?: string;
  name?: string;
}
const postJson = <T>(url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(json<T>);

export const fileDuplicate = (path: string) => postJson<FileOpResp>("/api/file/duplicate", { path });
export const fileRename = (path: string, name: string) =>
  postJson<FileOpResp>("/api/file/rename", { path, name });
export const fileConvert = (path: string, format: "jpg" | "png") =>
  postJson<FileOpResp>("/api/file/convert", { path, format });
export const folderCreate = (parent: string, name: string) =>
  postJson<FileOpResp>("/api/folder/create", { parent, name });
export const fileMove = (path: string, dest: string) =>
  postJson<FileOpResp>("/api/file/move", { path, dest });
// soft-delete: move into an "old/" subfolder (recoverable); returns where it went
export const fileToOld = (path: string) =>
  postJson<{ ok: boolean; original: string; moved: string }>("/api/file/old", { path });
// undo: move it back from `src` to its original `path`
export const fileRestore = (path: string, src: string) =>
  postJson<FileOpResp>("/api/file/restore", { path, src });
// PERMANENT delete (frontend confirms first)
export const fileDelete = (path: string) => postJson<FileOpResp>("/api/file/delete", { path });
// extract first/last frame of a video as a PNG still
export const videoFrame = (path: string, position: "first" | "last") =>
  postJson<FileOpResp>("/api/video/frame", { path, position });
// pull the embedded ComfyUI workflow out of a PNG into the workflows folder
export const workflowFromImage = (path: string, name?: string) =>
  postJson<{ ok: boolean; name: string; files: string[] }>("/api/workflows/from-image", { path, name });

export const revealPath = (path: string) =>
  fetch("/api/reveal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  }).then(json<{ ok: boolean }>);

export const expandWorkflow = (path: string) =>
  fetch("/api/expand-workflow", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  }).then(
    json<{ ok: boolean; mode: "live" | "file"; name?: string; saved?: string; comfyui_url: string }>,
  );

export const expandWorkflowUi = (path: string) =>
  fetch("/api/expand-workflow-ui", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  }).then(
    json<{ ok: boolean; mode: "live" | "file"; name?: string; saved?: string; comfyui_url: string }>,
  );

export interface FileTag {
  source?: string;
  ok?: boolean;
  labels?: string[];
}
export const getTags = (boardId: string) =>
  fetch(`/api/tags/${boardId}`).then(json<Record<string, FileTag>>);
export const setTag = (
  boardId: string,
  name: string,
  patch: { source?: string; ok?: boolean; labels?: string[] },
) =>
  fetch(`/api/tags/${boardId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, ...patch }),
  }).then(json<{ name: string; tag: FileTag }>);
