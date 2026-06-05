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
