import { useEffect, useRef, useState, type CSSProperties } from "react";
import { assetUrl, type AssetT } from "../api";

type Mode = "opacity" | "wipe" | "diff";
const MODES: Mode[] = ["opacity", "wipe", "diff"];
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// Overlay (superimposed) A/B comparison: opacity blend, wipe reveal, or difference.
// Fullscreen mode adds wheel-zoom + drag-pan (native listeners for reliability).
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
  const [full, setFull] = useState(false);
  const [scale, setScale] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const scaleRef = useRef(1);
  const offRef = useRef({ x: 0, y: 0 });
  const stageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  const setS = (s: number) => {
    scaleRef.current = s;
    setScale(s);
  };
  const setO = (o: { x: number; y: number }) => {
    offRef.current = o;
    setOff(o);
  };

  // reset zoom/pan when leaving fullscreen
  useEffect(() => {
    if (!full) {
      setS(1);
      setO({ x: 0, y: 0 });
    }
  }, [full]);

  // Escape exits fullscreen first (without closing the whole panel)
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setFull(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [full]);

  // wheel-zoom (anchored at cursor) + drag-pan — native listeners, fullscreen only
  useEffect(() => {
    if (!full) return;
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cur = scaleRef.current;
      const next = clamp(cur * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.2, 12);
      const rect = stage.getBoundingClientRect();
      const cx = e.clientX - (rect.left + rect.width / 2);
      const cy = e.clientY - (rect.top + rect.height / 2);
      const f = next / cur;
      setO({ x: cx - (cx - offRef.current.x) * f, y: cy - (cy - offRef.current.y) * f });
      setS(next);
    };
    const onDown = (e: MouseEvent) => {
      drag.current = { sx: e.clientX, sy: e.clientY, ox: offRef.current.x, oy: offRef.current.y };
    };
    const onMove = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      setO({ x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) });
    };
    const onUp = () => {
      drag.current = null;
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    stage.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      stage.removeEventListener("wheel", onWheel);
      stage.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [full]);

  const topStyle: CSSProperties =
    mode === "opacity"
      ? { opacity: v / 100 }
      : mode === "diff"
        ? { mixBlendMode: "difference" }
        : { clipPath: `inset(0 ${100 - v}% 0 0)` }; // wipe: reveal left v%

  const panelStyle: CSSProperties | undefined = full
    ? {
        position: "fixed",
        inset: 0,
        width: "auto",
        height: "auto",
        maxWidth: "none",
        maxHeight: "none",
        zIndex: 60,
        borderRadius: 0,
        display: "flex",
        flexDirection: "column",
      }
    : undefined;

  const zoomStyle: CSSProperties | undefined = full
    ? {
        transform: `translate(${off.x}px, ${off.y}px) scale(${scale})`,
        transformOrigin: "center center",
        cursor: "grab",
      }
    : undefined;

  return (
    <div className="compare-panel" style={panelStyle}>
      <div className="compare-head">
        <span className="compare-title">A/B overlay{full ? `  ·  ${Math.round(scale * 100)}%` : ""}</span>
        <div className="compare-modes">
          {MODES.map((m) => (
            <button key={m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
              {m}
            </button>
          ))}
        </div>
        <button className="compare-close" title={full ? "元のサイズ" : "全画面"} onClick={() => setFull((f) => !f)}>
          {full ? "🗗" : "⛶"}
        </button>
        <button className="compare-close" onClick={onClose}>
          ×
        </button>
      </div>

      <div
        className="compare-stage"
        ref={stageRef}
        style={full ? { flex: 1, width: "100%", height: "auto", maxHeight: "none", margin: 0 } : undefined}
      >
        <div className="cmp-zoom" style={zoomStyle}>
          {/* B = bottom reference */}
          <img className="cmp-img" src={assetUrl(b.path)} alt={b.name} draggable={false} />
          {/* A = top */}
          <img className="cmp-img cmp-top" style={topStyle} src={assetUrl(a.path)} alt={a.name} draggable={false} />
          {mode === "wipe" && <div className="cmp-divider" style={{ left: `${v}%` }} />}
        </div>
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
