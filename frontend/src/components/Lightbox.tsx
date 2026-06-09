import { useEffect, useRef, useState, type CSSProperties } from "react";
import { assetUrl, type AssetT } from "../api";

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// Fullscreen single-media viewer: wheel-zoom + drag-pan (images), ←/→ to switch media.
export function Lightbox({
  items,
  current,
  onSelect,
  onClose,
}: {
  items: AssetT[];
  current: AssetT;
  onSelect: (a: AssetT) => void;
  onClose: () => void;
}) {
  const [scale, setScale] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const scaleRef = useRef(1);
  const offRef = useRef({ x: 0, y: 0 });
  const stageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);

  const idx = items.findIndex((a) => a.path === current.path);
  const setS = (s: number) => {
    scaleRef.current = s;
    setScale(s);
  };
  const setO = (o: { x: number; y: number }) => {
    offRef.current = o;
    setOff(o);
  };

  const go = (delta: number) => {
    if (items.length < 2 || idx < 0) return;
    onSelect(items[(idx + delta + items.length) % items.length]);
  };

  // reset zoom/pan whenever the shown item changes
  useEffect(() => {
    setS(1);
    setO({ x: 0, y: 0 });
  }, [current.path]);

  // keyboard: ←/→ navigate, Esc close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, items]);

  // wheel-zoom (cursor-anchored) + drag-pan, images only
  useEffect(() => {
    if (current.kind !== "image") return;
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
      drag.current = { sx: e.clientX, sy: e.clientY, ox: offRef.current.x, oy: offRef.current.y, moved: false };
    };
    const onMove = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      d.moved = true;
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
  }, [current.path, current.kind]);

  const zoomStyle: CSSProperties = {
    transform: `translate(${off.x}px, ${off.y}px) scale(${scale})`,
    transformOrigin: "center center",
    cursor: scale > 1 ? "grab" : "default",
  };

  return (
    <div className="lightbox" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <button className="lb-close" onClick={onClose} title="閉じる (Esc)">
        ×
      </button>
      {items.length > 1 && (
        <button className="lb-nav lb-prev" onClick={(e) => (e.stopPropagation(), go(-1))} title="前へ (←)">
          ‹
        </button>
      )}
      <div className="lb-stage" ref={stageRef}>
        {current.kind === "video" ? (
          <video key={current.path} src={assetUrl(current.path)} controls autoPlay />
        ) : (
          <img
            key={current.path}
            className="lb-img"
            style={zoomStyle}
            src={assetUrl(current.path)}
            alt={current.name}
            draggable={false}
          />
        )}
      </div>
      {items.length > 1 && (
        <button className="lb-nav lb-next" onClick={(e) => (e.stopPropagation(), go(1))} title="次へ (→)">
          ›
        </button>
      )}
      <div className="lightbox-name">
        {current.name}
        {items.length > 1 ? `   (${idx + 1}/${items.length})` : ""}
        {current.kind === "image" && scale !== 1 ? `   ·  ${Math.round(scale * 100)}%` : ""}
      </div>
    </div>
  );
}
