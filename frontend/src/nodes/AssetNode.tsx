import { useState } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { assetUrl, type AssetT } from "../api";

export interface AssetNodeData extends Record<string, unknown> {
  asset: AssetT;
  boardId: string;
  kind?: string; // lineage: txt2img | i2i | vid2v
  source?: string; // origin: comfyui | photoshop | gemini | kling | seedance | <manual>
  ok?: boolean; // manual OK-take flag
  labels?: string[]; // manual free-text labels
  c2pa?: Record<string, string>; // extracted Content Credentials
  compact?: boolean; // render narrower (standalone material, not in a tree)
  workflow?: string; // workflow template name used to generate this asset
}
export type AssetNodeType = Node<AssetNodeData, "asset">;

// stable hex color for custom/manual source strings not in SOURCE_COLOR
const PALETTE = ["#ff7a7a", "#7c8cff", "#46c6d2", "#d2a04a", "#9b6bff", "#5ad28f", "#e06aa0", "#d27a46"];
function hashColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

const KIND_LABEL: Record<string, string> = { i2i: "i2i", vid2v: "Vi2V", txt2img: "txt2img" };

// subtle node tint by origin
const VIDEO_GREEN = "#46d27a";
const SOURCE_COLOR: Record<string, string> = {
  comfyui: "#e8c84a", // yellow
  photoshop: "#5bc8ff", // cyan / 水色
  gemini: "#e879d6", // pink (Google image)
  kling: VIDEO_GREEN, // green
  seedance: "#14b8a6", // teal (distinct from Kling)
  runway: VIDEO_GREEN,
  veo: VIDEO_GREEN,
  hailuo: VIDEO_GREEN,
  luma: VIDEO_GREEN,
  pika: VIDEO_GREEN,
  vidu: VIDEO_GREEN,
  sora: VIDEO_GREEN,
  minimax: VIDEO_GREEN,
  c2pa: VIDEO_GREEN,
  dalle: "#ff9f43", // orange
  midjourney: "#a877ff", // purple
  ae: "#818cf8", // After Effects — indigo
  premiere: "#b079f0", // Premiere — violet
  ame: "#6d8cf0", // Media Encoder
  doc: "#8b9bb4", // psd blue-grey
};
const OTHER_COLOR = "#9aa0a6"; // unknown / other
const SOURCE_LABEL: Record<string, string> = {
  comfyui: "Comfy", photoshop: "PS", gemini: "Gemini", kling: "Kling", seedance: "Seedance",
  runway: "Runway", veo: "Veo", dalle: "DALL·E", midjourney: "MJ", doc: "PSD", c2pa: "C2PA",
  ae: "AE", premiere: "Pr", ame: "AME",
};

// middle-truncate a long filename so the meaningful suffix (_gen1, _dpt) and the
// extension stay visible — "CIN_01A_048_For…_gen1.png" rather than "CIN_01A_048_For…"
function smartName(name: string, max = 52): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : "";
  const base = ext ? name.slice(0, -ext.length) : name;
  const tail = Math.min(12, Math.max(0, base.length - 4));
  const head = max - ext.length - tail - 1;
  if (head < 4) return name.slice(0, Math.max(1, max - 1)) + "…";
  return base.slice(0, head) + "…" + base.slice(base.length - tail) + ext;
}

export function AssetNode({ data, selected }: NodeProps<AssetNodeType>) {
  const { asset, kind } = data;
  const [vidErr, setVidErr] = useState(false); // ProRes/.mov can't play in the browser
  const badge = kind && kind !== "asset" ? KIND_LABEL[kind] ?? kind : null;
  const rawSrc = data.source ?? "";
  const src = rawSrc.toLowerCase();
  const tint = rawSrc ? SOURCE_COLOR[src] ?? hashColor(rawSrc) : null;
  const srcLabel = rawSrc ? SOURCE_LABEL[src] ?? rawSrc : null;
  const c2pa = data.c2pa;
  const c2paSummary = c2pa ? c2pa.description ?? c2pa.generator ?? c2pa.model ?? "C2PA" : null;
  const c2paFull = c2pa
    ? Object.entries(c2pa)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n")
    : undefined;
  return (
    <div
      className={`asset-node${selected ? " selected" : ""}${data.compact ? " compact" : ""}`}
      style={tint ? { borderColor: `${tint}88`, background: `${tint}1f` } : undefined}
      onDoubleClick={(e) => {
        if (asset.kind !== "image" && asset.kind !== "video") return;
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent("sc:view", { detail: { asset } }));
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        window.dispatchEvent(
          new CustomEvent("sc:ctx", {
            detail: {
              x: e.clientX,
              y: e.clientY,
              asset,
              boardId: data.boardId,
              source: data.source,
              ok: data.ok,
              labels: data.labels,
            },
          }),
        );
      }}
    >
      {tint && <div className="src-bar" style={{ background: tint }} />}
      <Handle type="target" position={Position.Left} />
      <div className="badge-row">
        {data.ok && <span className="ok-badge">OK</span>}
        {badge && <span className={`kind-badge kind-${kind}`}>{badge}</span>}
      </div>
      {srcLabel && (
        <span className="src-badge" style={{ background: tint ?? "#555", color: "#0b1020" }}>
          {srcLabel}
        </span>
      )}
      {data.workflow && (
        <span className="wf-badge" style={{ background: tint ? `${tint}66` : "#55555588" }}>
          {data.workflow}
        </span>
      )}
      <div className="asset-preview">
        {asset.kind === "image" && (
          <img src={assetUrl(asset.path)} alt={asset.name} draggable={false} />
        )}
        {asset.kind === "video" && !vidErr && (
          <video
            src={assetUrl(asset.path)}
            muted
            controls
            preload="metadata"
            onError={() => setVidErr(true)}
          />
        )}
        {asset.kind === "video" && vidErr && (
          <div className="asset-other">🎬 {asset.name.split(".").pop()?.toUpperCase()}</div>
        )}
        {asset.kind !== "image" && asset.kind !== "video" && (
          <div className="asset-other">{asset.name.split(".").pop()?.toUpperCase()}</div>
        )}
        {c2paSummary && (
          <div className="c2pa-line" title={c2paFull}>
            🔏 {c2paSummary}
          </div>
        )}
      </div>
      <div className="asset-name" title={asset.name}>
        {smartName(asset.name)}
      </div>
      {data.labels && data.labels.length > 0 && (
        <div className="label-row">
          {data.labels.map((l) => (
            <span key={l} className="label-chip">
              {l}
            </span>
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export interface BoardLabelData extends Record<string, unknown> {
  label: string;
  sub?: string;
}
export type BoardLabelType = Node<BoardLabelData, "boardLabel">;

export function BoardLabelNode({ data }: NodeProps<BoardLabelType>) {
  return (
    <div className="board-label">
      <strong>{data.label}</strong>
      {data.sub ? <span>{data.sub}</span> : null}
    </div>
  );
}
