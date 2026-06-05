import dagre from "@dagrejs/dagre";

export const NODE_W = 200;
export const NODE_H = 162;

// Tidy layered tree layout (Sugiyama via dagre): parent -> child left-to-right,
// siblings stacked top-to-bottom, crossings minimized. Handles multi-parent DAGs.
// Returns top-left positions keyed by asset name (origin not normalized).
export function layoutConnected(
  names: string[],
  edges: { from: string; to: string }[],
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 36, ranksep: 90, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));

  const present = new Set(names);
  for (const n of names) g.setNode(n, { width: NODE_W, height: NODE_H });
  for (const e of edges) {
    if (present.has(e.from) && present.has(e.to)) g.setEdge(e.from, e.to);
  }
  dagre.layout(g);

  const pos = new Map<string, { x: number; y: number }>();
  for (const n of names) {
    const nd = g.node(n) as { x: number; y: number };
    pos.set(n, { x: nd.x - NODE_W / 2, y: nd.y - NODE_H / 2 });
  }
  return pos;
}
