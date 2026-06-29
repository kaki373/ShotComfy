import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
} from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import { AssetNode, BoardLabelNode, type AssetNodeData } from "./nodes/AssetNode";
import { CompareOverlay } from "./components/CompareOverlay";
import { Lightbox } from "./components/Lightbox";
import JobBuilder, { type SelItem } from "./components/JobBuilder";
import { TreeView } from "./components/TreeView";
import { layoutConnected, NODE_H, NODE_W } from "./layout";
import {
  expandWorkflow,
  expandWorkflowUi,
  fileConvert,
  fileDelete,
  fileDuplicate,
  fileMove,
  fileRename,
  fileRestore,
  fileToOld,
  folderCreate,
  getBoard,
  purgeOld,
  videoFrame,
  workflowFromImage,
  getComfyStatus,
  getConfig,
  getLineage,
  getTags,
  getTree,
  openFolder,
  pickFolder,
  revealPath,
  setMode,
  setTag,
  uploadFiles,
  type AssetT,
  type BoardDetail,
  type ComfyStatus,
  type ConfigT,
  type FileTag,
  type Lineage,
  type LineageNode,
  type TreeNode,
} from "./api";

const nodeTypes = { asset: AssetNode, boardLabel: BoardLabelNode };

// recursive folder list for the "move to folder" picker
function MoveRows({
  node,
  depth,
  onPick,
}: {
  node: TreeNode;
  depth: number;
  onPick: (path: string) => void;
}) {
  return (
    <>
      <button className="move-row" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onPick(node.path)}>
        📁 {node.name || "/"}
      </button>
      {node.children.map((c) => (
        <MoveRows key={c.path} node={c} depth={depth + 1} onPick={onPick} />
      ))}
    </>
  );
}

// Properties dialog — shows lineage metadata for a single asset
function PropsDialog({
  asset,
  boardId,
  onClose,
}: {
  asset: AssetT;
  boardId: string;
  onClose: () => void;
}) {
  const [node, setNode] = useState<LineageNode | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getLineage(boardId)
      .then((lin) => {
        const found = lin.nodes.find((n) => n.name === asset.name) ?? null;
        setNode(found);
      })
      .catch(() => setNode(null))
      .finally(() => setLoading(false));
  }, [boardId, asset.name]);

  const row = (key: string, val: unknown) => {
    if (val === undefined || val === null || val === "") return null;
    return (
      <div className="props-row" key={key}>
        <span className="props-key">{key}</span>
        <span className="props-val">{String(val)}</span>
      </div>
    );
  };

  return (
    <div className="props-overlay" onClick={onClose}>
      <div className="props-modal" onClick={(e) => e.stopPropagation()}>
        <h3>プロパティ: {asset.name}</h3>
        {loading && <div style={{ color: "#888" }}>読み込み中…</div>}
        {!loading && !node && <div style={{ color: "#888" }}>リネージ情報なし</div>}
        {!loading && node && (
          <>
            {row("source", node.source)}
            {row("kind", node.kind)}
            {row("has_comfy", node.has_comfy ? "Yes" : "No")}
            {node.params && Object.keys(node.params).length > 0 && (
              <>
                <div style={{ marginTop: 8, marginBottom: 4, color: "#8888aa", fontSize: 12 }}>
                  パラメータ
                </div>
                {Object.entries(node.params).map(([k, v]) => row(k, v))}
              </>
            )}
            {node.inputs.length > 0 && (
              <>
                <div style={{ marginTop: 8, marginBottom: 4, color: "#8888aa", fontSize: 12 }}>
                  入力
                </div>
                {node.inputs.map((inp, i) => (
                  <div className="props-row" key={i}>
                    <span className="props-val">{inp}</span>
                  </div>
                ))}
              </>
            )}
          </>
        )}
        <button onClick={onClose}>閉じる</button>
      </div>
    </div>
  );
}

const COL_W = 340;
const ROW_H = 260;
const TOP = 80;
const GRID_COLS = 5; // columns for the standalone-assets grid
const BAND_H = 1600; // vertical space reserved per open board
// all nodes share one size now; these are the grid/timeline column/row steps
const COMPACT_W = 200;
const COMPACT_ROW = 162;

// split connected lineage assets into separate trees (connected components)
function components(names: Set<string>, edges: { from: string; to: string }[]): string[][] {
  const parent = new Map<string, string>();
  for (const n of names) parent.set(n, n);
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) {
      const p = parent.get(x)!;
      parent.set(x, r);
      x = p;
    }
    return r;
  };
  for (const e of edges) {
    if (names.has(e.from) && names.has(e.to)) {
      const ra = find(e.from);
      const rb = find(e.to);
      if (ra !== rb) parent.set(ra, rb);
    }
  }
  const groups = new Map<string, string[]>();
  for (const n of names) {
    const r = find(n);
    (groups.get(r) ?? groups.set(r, []).get(r)!).push(n);
  }
  return [...groups.values()];
}

// web AI video generators that name downloads "<Tool> ... .mp4" — every output of one
// tool is a sibling (the prompt lives in the filename, not metadata).
const GEN_TOOLS = [
  "kling", "seedance", "runway", "gen-3", "gen3", "hailuo", "minimax", "luma",
  "dream machine", "pika", "vidu", "sora", "veo", "haiper", "kaiber", "wan",
  "mochi", "ltx", "cogvideo", "hunyuan",
];
function toolOf(name: string): string | null {
  const lo = name.toLowerCase();
  return GEN_TOOLS.find((t) => lo.startsWith(t)) ?? null;
}

// AI image generators (by download filename) — used to tell generated vs not
const IMG_GEN = [
  "chatgpt", "dall", "dalle", "gemini", "nanobanana", "nano-banana", "imagen",
  "firefly", "midjourney", "niji", "stablediffusion", "sdxl",
];
function isImgGenName(name: string): boolean {
  const lo = name.toLowerCase();
  return IMG_GEN.some((t) => lo.startsWith(t));
}

// origin guessed from filename — for media with NO usable metadata (videos) and a few
// image generators that name their downloads. ComfyUI is intentionally NOT inferred from
// the filename: "Comfy" is assigned only from real ComfyUI metadata (backend source).
function nameSource(name: string): string {
  const lo = name.toLowerCase();
  const tool = toolOf(name);
  if (tool) return tool; // kling / seedance / runway / ...
  if (lo.startsWith("gemini") || lo.startsWith("nanobanana") || lo.startsWith("nano-banana")) return "gemini";
  if (lo.startsWith("dall") || lo.startsWith("chatgpt")) return "dalle";
  if (lo.startsWith("midjourney") || lo.startsWith("niji")) return "midjourney";
  return "";
}

// numbered variation key: filename stem with digit-runs blanked (foo_001 == foo_002)
function siblingKey(name: string): string {
  const stem = name.replace(/\.[^.]+$/, "");
  let k = stem.replace(/\d+/g, "#").replace(/[ _\-().]+/g, "_");
  k = k.replace(/_+/g, "_").replace(/^_|_$/g, "");
  return k.toLowerCase();
}

// files created within this many seconds of each other = one batch (siblings)
const TIME_GAP = 90;
// same Adobe editing tool within this window = siblings (a working session)
const EDIT_GAP = 1200; // 20 min (Photoshop/Premiere/AME)
const AE_GAP = 3600; // 1 hour (After Effects sessions run longer)
const ADOBE_SRC = new Set(["ae", "photoshop", "premiere", "ame"]);

// Sibling groups for the standalone timeline: two files are siblings if they share
// a video tool, OR a numbered-variation name, OR were created close in time, OR are
// from the same Adobe tool (AE/PS) in the same time window. Merged via union-find.
function groupSiblings(assets: AssetT[], sourceOf: (a: AssetT) => string): AssetT[][] {
  const parent = assets.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const firstTool = new Map<string, number>();
  const firstKey = new Map<string, number>();
  assets.forEach((a, i) => {
    const tool = toolOf(a.name);
    if (tool) {
      const seen = firstTool.get(tool);
      if (seen !== undefined) union(i, seen);
      else firstTool.set(tool, i);
    } else {
      const k = siblingKey(a.name);
      if (k && k !== "#") {
        const seen = firstKey.get(k);
        if (seen !== undefined) union(i, seen);
        else firstKey.set(k, i);
      }
    }
  });

  // time adjacency (non-tool files only, so a CG render near a Kling clip stays separate)
  const order = assets.map((_, i) => i).sort((i, j) => assets[i].mtime - assets[j].mtime);
  for (let p = 1; p < order.length; p++) {
    const a = assets[order[p - 1]];
    const b = assets[order[p]];
    if (!toolOf(a.name) && !toolOf(b.name) && b.mtime - a.mtime <= TIME_GAP) {
      union(order[p - 1], order[p]);
    }
  }

  // same Adobe tool (AE / Photoshop) within a working session -> siblings
  const adobe = order.filter((i) => ADOBE_SRC.has((sourceOf(assets[i]) || "").toLowerCase()));
  for (let p = 1; p < adobe.length; p++) {
    const a = assets[adobe[p - 1]];
    const b = assets[adobe[p]];
    const gap = sourceOf(a) === "ae" ? AE_GAP : EDIT_GAP;
    if (sourceOf(a) === sourceOf(b) && b.mtime - a.mtime <= gap) {
      union(adobe[p - 1], adobe[p]);
    }
  }

  const groups = new Map<number, AssetT[]>();
  assets.forEach((a, i) => {
    const r = find(i);
    (groups.get(r) ?? groups.set(r, []).get(r)!).push(a);
  });
  const out = [...groups.values()];
  for (const g of out) g.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
  out.sort((a, b) => Math.min(...a.map((x) => x.mtime)) - Math.min(...b.map((x) => x.mtime)));
  return out;
}

type GenFilter = "all" | "gen" | "nongen";

// persisted canvas-toolbar settings (top-left toggles + ⚙ spacing)
const SETTINGS_KEY = "shotcomfy.settings";
interface Settings {
  genFilter: GenFilter;
  treesByTime: boolean;
  continuous: boolean;
  showTags: boolean;
  gridCols: number;
  gapX: number;
  gapY: number;
}
const DEFAULT_SETTINGS: Settings = {
  genFilter: "all",
  treesByTime: false,
  continuous: false,
  showTags: true,
  gridCols: 4,
  gapX: 12,
  gapY: 12,
};
function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

interface LayoutOpts {
  treesByTime: boolean;
  genFilter: GenFilter; // all / generated-only / non-generated-only (PSD always shown)
  gridCols: number; // columns for the compact standalone grid
  gapX: number; // extra horizontal spacing (px) between compact nodes
  gapY: number; // extra vertical spacing (px) between compact nodes
}

// Each lineage tree is laid out tidily with dagre (parent->child L-R, siblings up/down).
// Default: trees stacked vertically, standalone assets in a grid below.
// treesByTime: trees AND standalone files placed on one chronological timeline
// (left->right by creation time) so lone images that fall between trees interleave.
function buildBoardGraph(
  board: BoardDetail,
  lineage: Lineage | null,
  tags: Record<string, FileTag>,
  band: number,
  opts: LayoutOpts,
) {
  const kindByName = new Map<string, string>();
  const genByName = new Map<string, boolean>();
  const sourceByName = new Map<string, string>();
  const c2paByName = new Map<string, Record<string, string>>();
  const workflowByName = new Map<string, string>();
  for (const n of lineage?.nodes ?? []) {
    kindByName.set(n.name, n.kind);
    genByName.set(n.name, n.generated);
    sourceByName.set(n.name, n.source);
    if (n.c2pa && Object.keys(n.c2pa).length) c2paByName.set(n.name, n.c2pa);
    if (n.workflow) workflowByName.set(n.name, n.workflow);
  }
  // origin for node tinting: a manual tag wins; else generator filename (e.g. ComfyUI_Upscale
  // even after a Photoshop round-trip strips the prompt), else backend metadata.
  const sourceOf = (a: AssetT): string => {
    const manual = tags[a.name]?.source;
    if (manual) return manual; // manual tag wins
    if (a.kind === "doc") return "doc";
    // metadata (ComfyUI / Gemini / Photoshop / After Effects / C2PA) wins over filename;
    // filename (Kling/Seedance) is only the fallback for media with no usable metadata.
    return sourceByName.get(a.name) || nameSource(a.name) || "";
  };
  // generated = backend metadata (ComfyUI prompt / Gemini-SynthID / C2PA video) OR a
  // video/image generator filename (Kling/Seedance/Runway video, GPT/Gemini image name).
  // ComfyUI images need real metadata (stripped/edited ones are NOT counted). PSD = source.
  const isGenName = (name: string) => isImgGenName(name) || toolOf(name) != null;
  const generatedOf = (a: AssetT) =>
    a.kind !== "doc" && (genByName.get(a.name) === true || isGenName(a.name));
  const keep = (a: AssetT) => {
    if (opts.genFilter === "gen") return generatedOf(a);
    if (opts.genFilter === "nongen") return !generatedOf(a);
    return true;
  };
  const assetList = board.assets.filter(keep);

  const mtimeByName = new Map(assetList.map((a) => [a.name, a.mtime]));
  const names = new Set(assetList.map((a) => a.name));
  const inFolder = (lineage?.edges ?? []).filter(
    (e) => !e.external && names.has(e.from) && names.has(e.to),
  );

  const connected = new Set<string>();
  for (const e of inFolder) {
    connected.add(e.from);
    connected.add(e.to);
  }

  // lay out each tree on its own, normalized to (0,0), with its size + earliest time
  const trees = (connected.size ? components(connected, inFolder) : []).map((c) => {
    const pos = layoutConnected(c, inFolder);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = 0;
    let maxY = 0;
    for (const p of pos.values()) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + NODE_W);
      maxY = Math.max(maxY, p.y + NODE_H);
    }
    const norm = new Map<string, { x: number; y: number }>();
    for (const [n, p] of pos) norm.set(n, { x: p.x - minX, y: p.y - minY });
    const minMtime = Math.min(...c.map((n) => mtimeByName.get(n) ?? 0));
    return { pos: norm, w: maxX - minX, h: maxY - minY, minMtime };
  });

  const isolated = assetList
    .filter((a) => !connected.has(a.name))
    .sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));

  const GAP = 130;
  const stepX = COMPACT_W + opts.gapX; // compact column step (node width + gap)
  const stepY = COMPACT_ROW + opts.gapY;
  const placed = new Map<string, { x: number; y: number }>(); // y relative to TOP

  if (opts.treesByTime) {
    // single timeline: trees + standalone files interleaved left->right by time
    type Item = { time: number; w: number; apply: (ox: number) => void };
    const items: Item[] = [];
    for (const t of trees) {
      items.push({
        time: t.minMtime,
        w: t.w,
        apply: (ox) => {
          for (const [n, p] of t.pos) placed.set(n, { x: ox + p.x, y: p.y });
        },
      });
    }
    // standalone "pattern" variations stack vertically as siblings at one time column
    for (const group of groupSiblings(isolated, sourceOf)) {
      const time = Math.min(...group.map((a) => a.mtime));
      items.push({
        time,
        w: COMPACT_W,
        apply: (ox) => group.forEach((a, i) => placed.set(a.name, { x: ox, y: i * stepY })),
      });
    }
    items.sort((x, y) => x.time - y.time);
    let cursor = 0;
    for (const it of items) {
      it.apply(cursor);
      cursor += it.w + opts.gapX; // horizontal gap is the slider (can be 0)
    }
  } else {
    // causal layout: standalone source images on the LEFT, lineage trees on the RIGHT
    // (left -> right reads "materials -> generated results")
    const cols = Math.max(1, opts.gridCols);
    isolated.forEach((a, i) => {
      placed.set(a.name, {
        x: (i % cols) * stepX,
        y: Math.floor(i / cols) * stepY,
      });
    });
    const leftW = isolated.length ? Math.min(cols, isolated.length) * stepX : 0;
    const treeX = isolated.length ? leftW + 80 : 0;
    trees.sort((a, b) => a.minMtime - b.minMtime);
    let cursor = 0;
    for (const t of trees) {
      for (const [n, p] of t.pos) placed.set(n, { x: treeX + p.x, y: cursor + p.y });
      cursor += t.h + GAP;
    }
  }

  const assetId = (name: string) => `asset:${board.id}:${name}`;
  const nodes: Node[] = [
    {
      id: `label:${board.id}`,
      type: "boardLabel",
      position: { x: 0, y: band },
      draggable: false,
      selectable: false,
      data: { label: board.label, sub: board.path },
    },
  ];
  for (const a of assetList) {
    const p = placed.get(a.name);
    if (!p) continue;
    nodes.push({
      id: assetId(a.name),
      type: "asset",
      position: { x: p.x, y: band + TOP + p.y },
      data: {
        asset: a,
        boardId: board.id,
        kind: kindByName.get(a.name),
        source: sourceOf(a),
        ok: tags[a.name]?.ok,
        labels: tags[a.name]?.labels,
        c2pa: c2paByName.get(a.name),
        workflow: workflowByName.get(a.name),
        compact: !connected.has(a.name),
      } satisfies AssetNodeData,
    });
  }

  const edges: Edge[] = inFolder.map((e) => ({
    id: `e:${board.id}:${e.from}->${e.to}`,
    source: assetId(e.from),
    target: assetId(e.to),
    label: e.label,
    animated: true,
  }));
  return { nodes, edges };
}

interface MenuState {
  x: number;
  y: number;
  asset: AssetT;
  boardId: string;
  source?: string;
  ok?: boolean;
  labels?: string[];
}
interface EditorState {
  asset: AssetT;
  boardId: string;
  source: string;
  labels: string; // comma-separated in the form
  ok: boolean;
}

const SRC_SUGGEST = ["RunwayUpscale", "Seedance", "Kling", "Runway", "ComfyUI", "Photoshop", "Gemini"];

export function App() {
  const rf = useReactFlow();
  const [config, setConfig] = useState<ConfigT | null>(null);
  const [comfy, setComfy] = useState<ComfyStatus | null>(null);
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [openIds, setOpenIds] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selected, setSelected] = useState<Node[]>([]);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const S0 = useRef(loadSettings()).current; // saved toolbar settings (read once)
  const [treesByTime, setTreesByTime] = useState(S0.treesByTime);
  const treesByTimeRef = useRef(S0.treesByTime);
  const [genFilter, setGenFilter] = useState<GenFilter>(S0.genFilter);
  const genFilterRef = useRef<GenFilter>(S0.genFilter);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [propsModal, setPropsModal] = useState<{asset: AssetT; boardId: string} | null>(null);
  const [treeMenu, setTreeMenu] = useState<{ x: number; y: number; path: string; name: string } | null>(null);
  const [movePicker, setMovePicker] = useState<{ items: { asset: AssetT; boardId: string }[] } | null>(null);
  const undoRef = useRef<{ boardId: string; original: string; moved: string }[][]>([]);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [viewer, setViewer] = useState<AssetT | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showTags, setShowTags] = useState(S0.showTags);
  const [continuous, setContinuous] = useState(S0.continuous);
  const continuousRef = useRef(S0.continuous);
  const [gridCols, setGridCols] = useState(S0.gridCols);
  const gridColsRef = useRef(S0.gridCols);
  const [gapX, setGapX] = useState(S0.gapX);
  const gapXRef = useRef(S0.gapX);
  const [gapY, setGapY] = useState(S0.gapY);
  const gapYRef = useRef(S0.gapY);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // persist toolbar toggles + spacing across app restarts
  useEffect(() => {
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({ genFilter, treesByTime, continuous, showTags, gridCols, gapX, gapY }),
      );
    } catch {
      /* ignore storage quota */
    }
  }, [genFilter, treesByTime, continuous, showTags, gridCols, gapX, gapY]);

  const dataCacheRef = useRef<
    Map<string, { board: BoardDetail; lineage: Lineage | null; tags: Record<string, FileTag> }>
  >(new Map());

  useEffect(() => {
    getConfig().then(setConfig).catch(() => {});
    getTree().then(setTree).catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = () => getComfyStatus().then((s) => alive && setComfy(s)).catch(() => {});
    tick();
    const h = setInterval(tick, 10000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, []);

  const folder = useMemo(
    () => ((config?.target?.folder ?? config?.target?.root) as string | undefined) ?? null,
    [config],
  );

  const currentOpts = (): LayoutOpts => ({
    treesByTime: treesByTimeRef.current,
    genFilter: genFilterRef.current,
    gridCols: gridColsRef.current,
    gapX: gapXRef.current,
    gapY: gapYRef.current,
  });

  // rebuild the given boards (by id, in order) from cached data — bands by index
  const buildFrom = useCallback(
    (ids: string[]) => {
      const opts = currentOpts();
      const ns: Node[] = [];
      const es: Edge[] = [];
      ids.forEach((id, col) => {
        const c = dataCacheRef.current.get(id);
        if (!c) return;
        const g = buildBoardGraph(c.board, c.lineage, c.tags, col * BAND_H, opts);
        ns.push(...g.nodes);
        es.push(...g.edges);
      });
      setNodes(ns);
      setEdges(es);
    },
    [setNodes, setEdges],
  );

  const relayoutAll = useCallback(() => buildFrom(openIds), [buildFrom, openIds]);

  const openBoard = useCallback(
    async (id: string) => {
      setActiveId(id);
      const multi = continuousRef.current; // "選択フォルダ全表示" = multi-select mode
      if (multi && openIds.includes(id)) {
        // already selected -> deselect (remove its nodes/trees)
        const next = openIds.filter((x) => x !== id);
        setOpenIds(next);
        buildFrom(next);
        return;
      }
      const [board, lineage, tags] = await Promise.all([
        getBoard(id),
        getLineage(id).catch(() => null),
        getTags(id).catch(() => ({})),
      ]);
      dataCacheRef.current.set(id, { board, lineage, tags });
      const next = multi ? [...openIds, id] : [id]; // add to selection, or switch to just this
      setOpenIds(next);
      buildFrom(next);
      setTimeout(() => rf.fitView({ duration: 400, padding: 0.2 }), 140);
    },
    [openIds, buildFrom, rf],
  );

  const refreshBoard = useCallback(
    async (id: string) => {
      if (!openIds.includes(id)) return;
      const [board, lineage, tags] = await Promise.all([
        getBoard(id),
        getLineage(id).catch(() => null),
        getTags(id).catch(() => ({})),
      ]);
      dataCacheRef.current.set(id, { board, lineage, tags });
      relayoutAll();
    },
    [openIds, relayoutAll],
  );

  // re-fetch every open board (manual refresh button) — folder scans on a network
  // drive are slow, so a one-shot refresh keeps the canvas accurate on demand
  const [refreshing, setRefreshing] = useState(false);
  const refreshAllOpen = useCallback(async () => {
    if (!openIds.length) return;
    setRefreshing(true);
    try {
      await Promise.all(
        openIds.map(async (id) => {
          const [board, lineage, tags] = await Promise.all([
            getBoard(id),
            getLineage(id).catch(() => null),
            getTags(id).catch(() => ({})),
          ]);
          dataCacheRef.current.set(id, { board, lineage, tags });
        }),
      );
      relayoutAll();
      getTree().then(setTree).catch(() => {});
    } finally {
      setRefreshing(false);
    }
  }, [openIds, relayoutAll]);

  const onToggleTreesByTime = useCallback(
    (v: boolean) => {
      setTreesByTime(v);
      treesByTimeRef.current = v;
      relayoutAll();
      setTimeout(() => rf.fitView({ duration: 300 }), 60);
    },
    [relayoutAll, rf],
  );

  const onSetGridCols = useCallback(
    (v: number) => {
      setGridCols(v);
      gridColsRef.current = v;
      relayoutAll();
    },
    [relayoutAll],
  );

  const onSetGapX = useCallback(
    (v: number) => {
      setGapX(v);
      gapXRef.current = v;
      relayoutAll();
    },
    [relayoutAll],
  );

  const onSetGapY = useCallback(
    (v: number) => {
      setGapY(v);
      gapYRef.current = v;
      relayoutAll();
    },
    [relayoutAll],
  );

  const onSetGenFilter = useCallback(
    (v: GenFilter) => {
      setGenFilter(v);
      genFilterRef.current = v;
      relayoutAll();
      setTimeout(() => rf.fitView({ duration: 300 }), 60);
    },
    [relayoutAll, rf],
  );

  // preserve click order: keep previously-selected nodes in their order, append newly added
  // ones (React Flow reports selection in node-array order, not the order the user clicked).
  const onSelectionChange = useCallback((p: OnSelectionChangeParams) => {
    const assetNodes = p.nodes.filter((n) => n.type === "asset");
    setSelected((prev) => {
      const now = new Map(assetNodes.map((n) => [n.id, n]));
      const kept = prev.filter((n) => now.has(n.id)).map((n) => now.get(n.id)!);
      const keptIds = new Set(kept.map((n) => n.id));
      const added = assetNodes.filter((n) => !keptIds.has(n.id));
      return [...kept, ...added];
    });
  }, []);

  const reveal = useCallback((path: string) => {
    revealPath(path).catch((e) => window.alert(`エクスプローラで開けません: ${e}`));
  }, []);

  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 4000);
  }, []);

  // run a file operation, then refresh the affected board + folder tree
  const runFileOp = useCallback(
    async (boardId: string, label: string, op: () => Promise<{ name?: string }>) => {
      try {
        const r = await op();
        await refreshBoard(boardId);
        getTree().then(setTree).catch(() => {});
        setNotice(`${label}：${r.name ?? "完了"}`);
        setTimeout(() => setNotice(null), 3000);
      } catch (e) {
        window.alert(`${label}に失敗: ${e}`);
      }
    },
    [refreshBoard],
  );


  // remove asset nodes from the canvas immediately (optimistic) by file path
  const removeNodesByPath = useCallback(
    (paths: Set<string>) =>
      setNodes((ns) =>
        ns.filter((n) => {
          const a = (n.data as AssetNodeData)?.asset;
          return !(n.type === "asset" && a && paths.has(a.path));
        }),
      ),
    [setNodes],
  );

  // soft-delete: move into an "old/" folder (recoverable) + Ctrl+Z undo
  const sendToOld = useCallback(
    async (entries: { boardId: string; path: string }[]) => {
      if (!entries.length) return;
      const batch: { boardId: string; original: string; moved: string }[] = [];
      for (const e of entries) {
        try {
          const r = await fileToOld(e.path);
          batch.push({ boardId: e.boardId, original: r.original, moved: r.moved });
        } catch {
          /* skip */
        }
      }
      if (!batch.length) return;
      undoRef.current.push(batch);
      removeNodesByPath(new Set(batch.map((b) => b.original)));
      for (const b of [...new Set(batch.map((x) => x.boardId))]) await refreshBoard(b);
      getTree().then(setTree).catch(() => {});
      setSelected([]);
      showNotice(`${batch.length}件を old に送りました（Ctrl+Z で戻せます）`);
    },
    [refreshBoard, removeNodesByPath, showNotice],
  );

  const sendSelectedToOld = useCallback(() => {
    sendToOld(
      selected.map((n) => {
        const d = n.data as AssetNodeData;
        return { boardId: d.boardId, path: d.asset.path };
      }),
    );
  }, [selected, sendToOld]);

  const undoOld = useCallback(async () => {
    const batch = undoRef.current.pop();
    if (!batch) return;
    let n = 0;
    for (const it of batch) {
      try {
        await fileRestore(it.original, it.moved);
        n++;
      } catch {
        /* skip */
      }
    }
    for (const b of [...new Set(batch.map((x) => x.boardId))]) await refreshBoard(b);
    getTree().then(setTree).catch(() => {});
    showNotice(n ? `${n}件を戻しました` : "戻せませんでした");
  }, [refreshBoard, showNotice]);

  const deletePermanentPaths = useCallback(
    async (items: { boardId: string; path: string; name: string }[]) => {
      if (!items.length) return;
      const msg =
        items.length === 1
          ? `「${items[0].name}」を完全に削除します。`
          : `選択した ${items.length} 件を完全に削除します。`;
      if (!window.confirm(`${msg}\n元に戻せません。よろしいですか？`)) return;
      const removed = new Set<string>();
      const boards = new Set<string>();
      for (const it of items) {
        try {
          await fileDelete(it.path);
          removed.add(it.path);
          boards.add(it.boardId);
        } catch {
          /* skip */
        }
      }
      removeNodesByPath(removed);
      for (const b of boards) await refreshBoard(b);
      getTree().then(setTree).catch(() => {});
      setSelected([]);
      showNotice(`${removed.size}件を完全に削除しました`);
    },
    [refreshBoard, removeNodesByPath, showNotice],
  );

  // a right-click acts on the whole selection if the clicked node is part of it
  const menuTargets = useCallback(
    (m: MenuState): { asset: AssetT; boardId: string }[] => {
      const inSel = selected.some((n) => (n.data as AssetNodeData).asset.path === m.asset.path);
      if (inSel && selected.length > 1)
        return selected.map((n) => {
          const d = n.data as AssetNodeData;
          return { asset: d.asset, boardId: d.boardId };
        });
      return [{ asset: m.asset, boardId: m.boardId }];
    },
    [selected],
  );

  const pickMove = useCallback(
    async (destPath: string) => {
      if (!movePicker) return;
      const items = movePicker.items;
      setMovePicker(null);
      const moved: string[] = [];
      const boards = new Set<string>();
      for (const it of items) {
        try {
          await fileMove(it.asset.path, destPath);
          moved.push(it.asset.path);
          boards.add(it.boardId);
        } catch {
          /* skip individual failures */
        }
      }
      try {
        removeNodesByPath(new Set(moved));
        for (const b of boards) await refreshBoard(b);
        getTree().then(setTree).catch(() => {});
        setSelected([]);
        showNotice(`${moved.length}件を移動しました`);
      } catch (e) {
        window.alert(`移動に失敗: ${e}`);
      }
    },
    [movePicker, refreshBoard, removeNodesByPath, showNotice],
  );

  // tree right-click menu (folder operations)
  useEffect(() => {
    const h = (e: Event) => setTreeMenu((e as CustomEvent).detail);
    window.addEventListener("sc:treectx", h);
    return () => window.removeEventListener("sc:treectx", h);
  }, []);
  useEffect(() => {
    if (!treeMenu) return;
    const close = () => setTreeMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [treeMenu]);

  // Delete = trash selected; Ctrl/Cmd+Z = undo (ignored while typing in inputs)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "Delete" && selected.length && !viewer) {
        e.preventDefault();
        sendSelectedToOld();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undoOld();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, sendSelectedToOld, undoOld, viewer]);


  const onExpandWorkflow = useCallback(
    async (path: string) => {
      try {
        const r = await expandWorkflow(path);
        if (r.mode === "live") {
          showNotice("開いている ComfyUI にワークフローを展開しました 🧩");
        } else {
          showNotice(
            `ブリッジ未ロードのためファイル保存：${r.name}（ComfyUIを再起動するとライブ展開が有効になります）`,
          );
        }
      } catch (e) {
        window.alert(`ワークフロー展開に失敗: ${e}`);
      }
    },
    [showNotice],
  );

  // asset nodes dispatch a window event on right-click (React Flow's onNodeContextMenu
  // didn't fire reliably with this node setup, so we listen at the window level)
  useEffect(() => {
    const h = (e: Event) => setMenu((e as CustomEvent).detail as MenuState);
    window.addEventListener("sc:ctx", h);
    return () => window.removeEventListener("sc:ctx", h);
  }, []);

  useEffect(() => {
    const onView = (e: Event) => setViewer((e as CustomEvent).detail.asset as AssetT);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setViewer(null);
        setMenu(null);
        setEditor(null);
        setTreeMenu(null);
        setMovePicker(null);
      }
    };
    window.addEventListener("sc:view", onView);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("sc:view", onView);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const applyTag = useCallback(
    async (boardId: string, name: string, patch: { source?: string; ok?: boolean; labels?: string[] }) => {
      try {
        await setTag(boardId, name, patch);
        await refreshBoard(boardId);
      } catch (e) {
        window.alert(`タグ保存に失敗: ${e}`);
      }
    },
    [refreshBoard],
  );

  const selItems = useMemo<SelItem[]>(
    () =>
      selected.map((n) => {
        const d = n.data as AssetNodeData;
        return { asset: d.asset, boardId: d.boardId };
      }),
    [selected],
  );

  const compareImages = useMemo(() => {
    const imgs = selected
      .map((n) => (n.data as AssetNodeData).asset)
      .filter((a) => a.kind === "image");
    return imgs.length === 2 ? (imgs as [AssetT, AssetT]) : null;
  }, [selected]);

  // ordered viewable media on the canvas, for ←/→ navigation in the lightbox
  const viewerList = useMemo<AssetT[]>(
    () =>
      nodes
        .filter((n) => n.type === "asset")
        .map((n) => (n.data as AssetNodeData).asset)
        .filter((a) => a.kind === "image" || a.kind === "video"),
    [nodes],
  );

  const onChangeFolder = useCallback(async () => {
    let chosen: string | null = null;
    try {
      const res = await pickFolder();
      chosen = res.folder;
    } catch {
      /* fall through to manual */
    }
    if (!chosen) {
      const label = config?.mode === "project" ? "プロジェクトルート" : "作業フォルダ";
      chosen = window.prompt(`${label}のパスを入力`, folder ?? "D:/");
    }
    if (!chosen) return;
    try {
      const res = await openFolder(chosen, config?.mode);
      setNodes([]);
      setEdges([]);
      setOpenIds([]);
      setActiveId(null);
      setTree(res.tree);
      setConfig((c) => (c ? { ...c, mode: res.mode as "free" | "project", target: res.target } : c));
    } catch (e) {
      window.alert(`フォルダを開けません: ${e}`);
    }
  }, [folder, config, setNodes, setEdges]);

  const onSetMode = useCallback(
    async (mode: "free" | "project") => {
      if (config?.mode === mode) return;
      try {
        const res = await setMode(mode);
        setNodes([]);
        setEdges([]);
        setOpenIds([]);
        setActiveId(null);
        setTree(res.tree);
        setConfig((c) => (c ? { ...c, mode: res.mode as "free" | "project", target: res.target } : c));
      } catch (e) {
        window.alert(`モード切替に失敗: ${e}`);
      }
    },
    [config, setNodes, setEdges],
  );

  const onDrop = useCallback(
    async (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const files = Array.from(e.dataTransfer.files).filter(
        (f) => f.type.startsWith("image/") || f.type.startsWith("video/"),
      );
      if (files.length === 0) return;
      const target = activeId ?? tree?.board_id ?? ".";
      const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      try {
        const res = await uploadFiles(target, files);
        const stamp = Date.now();
        const newNodes: Node[] = res.saved.map((a, i) => ({
          id: `asset:${target}:drop:${stamp}:${i}`,
          type: "asset",
          position: { x: pos.x, y: pos.y + i * ROW_H },
          data: { asset: a as AssetT, boardId: target } satisfies AssetNodeData,
        }));
        setNodes((cur) => [...cur, ...newNodes]);
        if (!openIds.includes(target)) setOpenIds((cur) => [...cur, target]);
        getTree().then(setTree).catch(() => {});
      } catch (err) {
        window.alert(`アップロード失敗: ${err}`);
      }
    },
    [activeId, tree, openIds, rf, setNodes],
  );

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">ShotComfy</span>
        <div className="mode-toggle">
          <button className={config?.mode === "free" ? "on" : ""} onClick={() => onSetMode("free")}>
            Free
          </button>
          <button className={config?.mode === "project" ? "on" : ""} onClick={() => onSetMode("project")}>
            Project
          </button>
        </div>
        <button
          className="folder-btn"
          onClick={onChangeFolder}
          title={config?.mode === "project" ? "プロジェクトルートを選択" : "作業フォルダを選択"}
        >
          📁 {folder ?? "(フォルダ選択)"}
        </button>
        <span className={`comfy-dot ${comfy?.online ? "on" : "off"}`} />
        <span className="comfy-label">
          ComfyUI {comfy ? (comfy.online ? "online" : "offline") : "…"}
        </span>
        <div className="spacer" />
        <button
          className={`queue-btn ${builderOpen ? "on" : ""}`}
          onClick={() => setBuilderOpen((v) => !v)}
          title="選択画像をi2i/V2Vワークフローで生成"
        >
          ▶ ComfyUIで生成{selected.length ? ` (${selected.length}選択中)` : ""}
        </button>
      </header>

      <div className="body">
        <aside className="sidebar">
          <div className="sidebar-title">{config?.mode === "project" ? "Episodes / Cuts" : "Folders"}</div>
          {tree ? (
            <TreeView root={tree} openIds={openIds} activeId={activeId} onOpen={openBoard} />
          ) : (
            <div className="empty">…</div>
          )}
        </aside>

        <main
          className={`canvas${dragging ? " dragging" : ""}${showTags ? "" : " tags-off"}`}
          onDragOver={(e) => {
            e.preventDefault();
            if (!dragging) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onSelectionChange={onSelectionChange}
            onPaneClick={() => setMenu(null)}
            nodeTypes={nodeTypes}
            selectionKeyCode="Shift"
            deleteKeyCode={null}
            zoomOnDoubleClick={false}
            minZoom={0.05}
            maxZoom={8}
            fitView
          >
            <Background color="#3a3a42" gap={20} />
            <Controls />
            <MiniMap
              pannable
              zoomable
              style={{ background: "#15151a" }}
              maskColor="rgba(0,0,0,0.6)"
              nodeColor="#4a4a55"
              nodeStrokeColor="#6aa1ff"
            />
          </ReactFlow>

          <div className="canvas-toolbar">
            <div className="filter-seg" role="group" aria-label="表示フィルタ">
              {(
                [
                  ["all", "全表示", "▦"],
                  ["gen", "生成", "✨"],
                  ["nongen", "非生成", "🎨"],
                ] as const
              ).map(([m, label, icon]) => (
                <button
                  key={m}
                  className={`seg-${m}${genFilter === m ? " on" : ""}`}
                  onClick={() => onSetGenFilter(m)}
                  title={
                    m === "gen"
                      ? "AI生成の画像・動画のみ"
                      : m === "nongen"
                        ? "非生成（CG/実画像/PSD）のみ"
                        : "すべて表示"
                  }
                >
                  <span className="seg-ico">{icon}</span>
                  {label}
                </button>
              ))}
            </div>
            <label>
              <input
                type="checkbox"
                checked={treesByTime}
                onChange={(e) => onToggleTreesByTime(e.target.checked)}
              />
              時系列で右へ
            </label>
            <label>
              <input
                type="checkbox"
                checked={continuous}
                onChange={(e) => {
                  setContinuous(e.target.checked);
                  continuousRef.current = e.target.checked;
                }}
              />
              選択フォルダ全表示
            </label>
            <label>
              <input
                type="checkbox"
                checked={showTags}
                onChange={(e) => setShowTags(e.target.checked)}
              />
              出自カラー
            </label>
            <div className="tool-row">
              <button
                className="tool-btn"
                onClick={refreshAllOpen}
                disabled={refreshing}
                title="表示を最新に更新（複製・削除・移動などをすぐ反映）"
              >
                {refreshing ? "⏳ 更新中" : "🔄 更新"}
              </button>
              <button className="tool-btn" onClick={() => setSettingsOpen((o) => !o)}>
                ⚙ 間隔
              </button>
            </div>
          </div>

          {settingsOpen && (
            <div className="settings-pop">
              <div className="set-row">
                <span>コンパクト列数: {gridCols}</span>
                <input
                  type="range"
                  min={2}
                  max={8}
                  value={gridCols}
                  onChange={(e) => onSetGridCols(Number(e.target.value))}
                />
              </div>
              <div className="set-row">
                <span>横間隔: {gapX}px</span>
                <input
                  type="range"
                  min={0}
                  max={200}
                  value={gapX}
                  onChange={(e) => onSetGapX(Number(e.target.value))}
                />
              </div>
              <div className="set-row">
                <span>縦間隔: {gapY}px</span>
                <input
                  type="range"
                  min={0}
                  max={200}
                  value={gapY}
                  onChange={(e) => onSetGapY(Number(e.target.value))}
                />
              </div>
            </div>
          )}

          {menu && (
            <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
              <button
                onClick={() => {
                  reveal(menu.asset.path);
                  setMenu(null);
                }}
              >
                📂 エクスプローラで開く
              </button>
              {menu.source === "comfyui" && (
                <button
                  onClick={() => {
                    onExpandWorkflow(menu.asset.path);
                    setMenu(null);
                  }}
                >
                  🧩 ワークフローをComfyUIに展開
                </button>
              )}
              {menu.source === "comfyui" && (
                <button
                  onClick={() => {
                    expandWorkflowUi(menu.asset.path)
                      .then((r) => {
                        if (r.mode === "live") {
                          showNotice(`非API版ワークフロー「${r.name}」をComfyUIに展開しました 🧩`);
                        } else {
                          showNotice(`非API版ワークフロー「${r.name}」をファイル保存しました`);
                        }
                      })
                      .catch((e) => window.alert(`非API版展開に失敗: ${e}`));
                    setMenu(null);
                  }}
                >
                  🧩 ワークフローをComfyUIに展開(非API版)
                </button>
              )}
              {menu.source === "comfyui" && (
                <button
                  onClick={() => {
                    const a = menu.asset;
                    workflowFromImage(a.path)
                      .then((r) => showNotice(`ワークフロー抽出：${r.files.join(" / ")}`))
                      .catch((e) => window.alert(`抽出に失敗: ${e}`));
                    setMenu(null);
                  }}
                >
                  🧩 ワークフローを抽出（workflowsへ）
                </button>
              )}
              <button
                onClick={() => {
                  applyTag(menu.boardId, menu.asset.name, { ok: !menu.ok });
                  setMenu(null);
                }}
              >
                {menu.ok ? "✓ OK を解除" : "✓ OK にする"}
              </button>
              <button
                onClick={() => {
                  setEditor({
                    asset: menu.asset,
                    boardId: menu.boardId,
                    source: menu.source ?? "",
                    labels: (menu.labels ?? []).join(", "),
                    ok: !!menu.ok,
                  });
                  setMenu(null);
                }}
              >
                🏷 属性を設定…
              </button>
              <div className="ctx-div" />
              <button onClick={() => {
                setPropsModal({ asset: menu.asset, boardId: menu.boardId });
                setMenu(null);
              }}>
                📋 プロパティ…
              </button>

              <div className="ctx-div" />
              <button
                onClick={() => {
                  runFileOp(menu.boardId, "複製", () => fileDuplicate(menu.asset.path));
                  setMenu(null);
                }}
              >
                📄 複製
              </button>
              <button
                onClick={() => {
                  const nn = window.prompt("新しいファイル名", menu.asset.name);
                  if (nn) runFileOp(menu.boardId, "名前変更", () => fileRename(menu.asset.path, nn));
                  setMenu(null);
                }}
              >
                ✏️ 名前を変更…
              </button>
              {(menu.asset.kind === "image" || /\.ps[bd]$/i.test(menu.asset.name)) && (
                <div className="ctx-row">
                  <span className="ctx-row-label">🖼 変換</span>
                  <button
                    className="ctx-inline"
                    onClick={() => {
                      runFileOp(menu.boardId, "JPG変換", () => fileConvert(menu.asset.path, "jpg"));
                      setMenu(null);
                    }}
                  >
                    JPG
                  </button>
                  <button
                    className="ctx-inline"
                    onClick={() => {
                      runFileOp(menu.boardId, "PNG変換", () => fileConvert(menu.asset.path, "png"));
                      setMenu(null);
                    }}
                  >
                    PNG
                  </button>
                </div>
              )}
              {menu.asset.kind === "video" && (
                <div className="ctx-row">
                  <span className="ctx-row-label">🎬 フレーム</span>
                  <button
                    className="ctx-inline"
                    onClick={() => {
                      runFileOp(menu.boardId, "先頭フレーム", () => videoFrame(menu.asset.path, "first"));
                      setMenu(null);
                    }}
                  >
                    先頭
                  </button>
                  <button
                    className="ctx-inline"
                    onClick={() => {
                      runFileOp(menu.boardId, "末尾フレーム", () => videoFrame(menu.asset.path, "last"));
                      setMenu(null);
                    }}
                  >
                    末尾
                  </button>
                </div>
              )}
              <button
                onClick={() => {
                  setMovePicker({ items: menuTargets(menu) });
                  setMenu(null);
                }}
              >
                📦 フォルダへ移動…{(() => {
                  const n = menuTargets(menu).length;
                  return n > 1 ? `（${n}件）` : "";
                })()}
              </button>
              <button
                onClick={() => {
                  sendToOld(menuTargets(menu).map((t) => ({ boardId: t.boardId, path: t.asset.path })));
                  setMenu(null);
                }}
              >
                🗄 old に送る{(() => {
                  const n = menuTargets(menu).length;
                  return n > 1 ? `（${n}件）` : "";
                })()}
              </button>
              <button
                className="ctx-del"
                onClick={() => {
                  deletePermanentPaths(
                    menuTargets(menu).map((t) => ({
                      boardId: t.boardId,
                      path: t.asset.path,
                      name: t.asset.name,
                    })),
                  );
                  setMenu(null);
                }}
              >
                🗑 完全に削除…{(() => {
                  const n = menuTargets(menu).length;
                  return n > 1 ? `（${n}件）` : "";
                })()}
              </button>
            </div>
          )}

          {treeMenu && (
            <div className="context-menu" style={{ left: treeMenu.x, top: treeMenu.y }}>
              <button
                onClick={() => {
                  const fn = window.prompt(`「${treeMenu.name || "/"}」内に作る新しいフォルダ名`);
                  if (fn)
                    folderCreate(treeMenu.path, fn)
                      .then(() => getTree().then(setTree))
                      .catch((e) => window.alert(`フォルダ作成に失敗: ${e}`));
                  setTreeMenu(null);
                }}
              >
                📁 フォルダを作成…
              </button>
              <button
                onClick={() => {
                  reveal(treeMenu.path);
                  setTreeMenu(null);
                }}
              >
                📂 エクスプローラで開く
              </button>
              <div className="ctx-div" />
              <button
                onClick={() => {
                  sendToOld([{ boardId: "", path: treeMenu.path }]);
                  setTreeMenu(null);
                }}
              >
                🗄 old に送る
              </button>
              <button
                className="ctx-del"
                onClick={() => {
                  deletePermanentPaths([
                    { boardId: "", path: treeMenu.path, name: treeMenu.name || "このフォルダ" },
                  ]);
                  setTreeMenu(null);
                }}
              >
                🗑 完全に削除…
              </button>
              {tree && treeMenu.path === tree.path && (
                <>
                  <div className="ctx-div" />
                  <button
                    className="ctx-del"
                    onClick={() => {
                      const root = treeMenu.path;
                      if (
                        window.confirm(
                          "配下のすべての「old」フォルダを完全に削除します。\n中身は元に戻せません。よろしいですか？",
                        )
                      ) {
                        purgeOld(root)
                          .then((r) => {
                            showNotice(`old フォルダ ${r.count} 個を削除しました`);
                            getTree().then(setTree).catch(() => {});
                            refreshAllOpen();
                          })
                          .catch((e) => window.alert(`削除に失敗: ${e}`));
                      }
                      setTreeMenu(null);
                    }}
                  >
                    🧹 すべての old フォルダを削除…
                  </button>
                </>
              )}
            </div>
          )}

          {movePicker && tree && (
            <div className="tag-editor-backdrop" onClick={() => setMovePicker(null)}>
              <div className="move-picker" onClick={(e) => e.stopPropagation()}>
                <div className="te-title">
                📦{" "}
                {movePicker.items.length === 1
                  ? `「${movePicker.items[0].asset.name}」`
                  : `${movePicker.items.length} 件`}
                の移動先フォルダ
              </div>
                <div className="move-tree">
                  <MoveRows node={tree} depth={0} onPick={pickMove} />
                </div>
                <div className="te-actions">
                  <button onClick={() => setMovePicker(null)}>キャンセル</button>
                </div>
              </div>
            </div>
          )}

          {editor && (
            <div className="tag-editor-backdrop" onClick={() => setEditor(null)}>
              <div className="tag-editor" onClick={(e) => e.stopPropagation()}>
                <div className="te-title" title={editor.asset.name}>
                  属性を設定: {editor.asset.name}
                </div>
                <label>
                  Source（出自）
                  <input
                    list="src-suggest"
                    value={editor.source}
                    onChange={(e) => setEditor({ ...editor, source: e.target.value })}
                    placeholder="例: RunwayUpscale"
                  />
                </label>
                <datalist id="src-suggest">
                  {SRC_SUGGEST.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
                <label>
                  ラベル（カンマ区切り・日本語可）
                  <input
                    value={editor.labels}
                    onChange={(e) => setEditor({ ...editor, labels: e.target.value })}
                    placeholder="例: BG, 要修正"
                  />
                </label>
                <div className="te-actions">
                  <button onClick={() => setEditor(null)}>キャンセル</button>
                  <button
                    className="te-save"
                    onClick={async () => {
                      const labels = editor.labels.split(",").map((s) => s.trim()).filter(Boolean);
                      await applyTag(editor.boardId, editor.asset.name, {
                        source: editor.source.trim(),
                        labels,
                      });
                      setEditor(null);
                    }}
                  >
                    保存
                  </button>
                </div>
              </div>
            </div>
          )}

          {dragging && <div className="drop-hint">画像をドロップして配置</div>}

          {compareImages && (
            <CompareOverlay a={compareImages[0]} b={compareImages[1]} onClose={() => setSelected([])} besideJb={builderOpen} />
          )}

          {notice && (
            <div className="toast notice" onClick={() => setNotice(null)}>
              {notice}
            </div>
          )}

          {viewer && (
            <Lightbox
              items={viewerList.some((a) => a.path === viewer.path) ? viewerList : [viewer]}
              current={viewer}
              onSelect={setViewer}
              onClose={() => setViewer(null)}
            />
          )}

          {propsModal && (
            <PropsDialog
              asset={propsModal.asset}
              boardId={propsModal.boardId}
              onClose={() => setPropsModal(null)}
            />
          )}

          <JobBuilder
            open={builderOpen}
            onClose={() => setBuilderOpen(false)}
            selected={selItems}
            onDone={(ids) => ids.forEach((id) => refreshBoard(id))}
            showNotice={showNotice}
          />
        </main>
      </div>
    </div>
  );
}
