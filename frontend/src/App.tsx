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
import { TreeView } from "./components/TreeView";
import { layoutConnected, NODE_H, NODE_W } from "./layout";
import {
  assetUrl,
  expandWorkflow,
  getBoard,
  getComfyStatus,
  getConfig,
  getLineage,
  getTags,
  getTree,
  openFolder,
  pickFolder,
  queueBoards,
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
  type QueueResp,
  type TreeNode,
} from "./api";

const nodeTypes = { asset: AssetNode, boardLabel: BoardLabelNode };

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
  for (const n of lineage?.nodes ?? []) {
    kindByName.set(n.name, n.kind);
    genByName.set(n.name, n.generated);
    sourceByName.set(n.name, n.source);
    if (n.c2pa && Object.keys(n.c2pa).length) c2paByName.set(n.name, n.c2pa);
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
  const [queueResp, setQueueResp] = useState<QueueResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [treesByTime, setTreesByTime] = useState(false);
  const treesByTimeRef = useRef(false);
  const [genFilter, setGenFilter] = useState<GenFilter>("all");
  const genFilterRef = useRef<GenFilter>("all");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [viewer, setViewer] = useState<AssetT | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showTags, setShowTags] = useState(true);
  const [continuous, setContinuous] = useState(false);
  const continuousRef = useRef(false);
  const [gridCols, setGridCols] = useState(4);
  const gridColsRef = useRef(4);
  const [gapX, setGapX] = useState(12);
  const gapXRef = useRef(12);
  const [gapY, setGapY] = useState(12);
  const gapYRef = useRef(12);
  const [settingsOpen, setSettingsOpen] = useState(false);
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

  const onSelectionChange = useCallback((p: OnSelectionChangeParams) => {
    setSelected(p.nodes.filter((n) => n.type === "asset"));
  }, []);

  const reveal = useCallback((path: string) => {
    revealPath(path).catch((e) => window.alert(`エクスプローラで開けません: ${e}`));
  }, []);

  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 4000);
  }, []);

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

  const selectedBoardIds = useMemo(() => {
    const ids = new Set<string>();
    for (const n of selected) ids.add((n.data as AssetNodeData).boardId);
    return [...ids];
  }, [selected]);

  const compareImages = useMemo(() => {
    const imgs = selected
      .map((n) => (n.data as AssetNodeData).asset)
      .filter((a) => a.kind === "image");
    return imgs.length === 2 ? (imgs as [AssetT, AssetT]) : null;
  }, [selected]);

  const onQueue = useCallback(async () => {
    if (selectedBoardIds.length === 0) return;
    setBusy(true);
    setQueueResp(null);
    try {
      const r = await queueBoards(selectedBoardIds, "default");
      setQueueResp(r);
      for (const id of selectedBoardIds) await refreshBoard(id);
    } catch (e) {
      setQueueResp({ workflow: "default", results: [{ board: "?", error: String(e) }] });
    } finally {
      setBusy(false);
    }
  }, [selectedBoardIds, refreshBoard]);

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
        <button className="queue-btn" disabled={busy || selectedBoardIds.length === 0} onClick={onQueue}>
          {busy ? "Generating…" : `Queue selected → ComfyUI (${selectedBoardIds.length})`}
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
            zoomOnDoubleClick={false}
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
            <button className="tool-btn" onClick={() => setSettingsOpen((o) => !o)}>
              ⚙ 間隔
            </button>
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
            <CompareOverlay a={compareImages[0]} b={compareImages[1]} onClose={() => setSelected([])} />
          )}

          {queueResp && (
            <div className="toast" onClick={() => setQueueResp(null)}>
              <pre>{JSON.stringify(queueResp, null, 2)}</pre>
            </div>
          )}

          {notice && (
            <div className="toast notice" onClick={() => setNotice(null)}>
              {notice}
            </div>
          )}

          {viewer && (
            <div className="lightbox" onClick={() => setViewer(null)}>
              {viewer.kind === "video" ? (
                <video
                  src={assetUrl(viewer.path)}
                  controls
                  autoPlay
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <img
                  src={assetUrl(viewer.path)}
                  alt={viewer.name}
                  onClick={(e) => e.stopPropagation()}
                />
              )}
              <div className="lightbox-name">{viewer.name}</div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
