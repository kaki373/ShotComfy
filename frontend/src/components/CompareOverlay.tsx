import { useState, type CSSProperties } from "react";
import { assetUrl, type AssetT } from "../api";

type Mode = "opacity" | "wipe" | "diff";
const MODES: Mode[] = ["opacity", "wipe", "diff"];

// Overlay (superimposed) A/B comparison: opacity blend, wipe reveal, or difference.
export function CompareOverlay({
  a,
  b,
  onClose,
}: {
  a: AssetT;
  b: AssetT;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>("opacity");
  const [v, setV] = useState(50);

  const topStyle: CSSProperties =
    mode === "opacity"
      ? { opacity: v / 100 }
      : mode === "diff"
        ? { mixBlendMode: "difference" }
        : {};

  return (
    <div className="compare-panel">
      <div className="compare-head">
        <span className="compare-title">A/B overlay</span>
        <div className="compare-modes">
          {MODES.map((m) => (
            <button key={m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
              {m}
            </button>
          ))}
        </div>
        <button className="compare-close" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="compare-stage">
        {/* B = bottom reference */}
        <img className="cmp-img" src={assetUrl(b.path)} alt={b.name} draggable={false} />
        {/* A = top */}
        {mode === "wipe" ? (
          <>
            <div className="cmp-wipe" style={{ width: `${v}%` }}>
              <img className="cmp-img" src={assetUrl(a.path)} alt={a.name} draggable={false} />
            </div>
            <div className="cmp-divider" style={{ left: `${v}%` }} />
          </>
        ) : (
          <img
            className="cmp-img cmp-top"
            style={topStyle}
            src={assetUrl(a.path)}
            alt={a.name}
            draggable={false}
          />
        )}
      </div>

      <input
        className="cmp-slider"
        type="range"
        min={0}
        max={100}
        value={v}
        onChange={(e) => setV(Number(e.target.value))}
      />
      <div className="compare-legend">
        <span>A (top): {a.name}</span>
        <span>B (bottom): {b.name}</span>
      </div>
    </div>
  );
}
