import { useCallback, useState } from "react";
import type { TreeNode } from "../api";

interface RowProps {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  toggle: (path: string) => void;
  openIds: string[];
  activeId: string | null;
  onOpen: (boardId: string) => void;
}

function TreeRow({ node, depth, expanded, toggle, openIds, activeId, onOpen }: RowProps) {
  const hasChildren = node.children.length > 0;
  const isExpanded = expanded.has(node.path);
  const openable = node.board_id != null;
  const isActive = openable && node.board_id === activeId;
  const isOpened = openable && node.board_id != null && openIds.includes(node.board_id);

  const onRowClick = () => {
    if (openable) onOpen(node.board_id as string);
    else if (hasChildren) toggle(node.path);
  };

  return (
    <div>
      <div
        className={`tree-row${isActive ? " active" : ""}${isOpened ? " opened" : ""}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={onRowClick}
        title={node.path}
      >
        <span
          className="tree-caret"
          onClick={
            hasChildren
              ? (e) => {
                  e.stopPropagation();
                  toggle(node.path);
                }
              : undefined // leaf: let the click bubble to the row so it opens
          }
        >
          {hasChildren ? (isExpanded ? "▾" : "▸") : ""}
        </span>
        <span className="tree-icon">{hasChildren ? "📁" : openable ? "🎬" : "📁"}</span>
        <span className="tree-name">{node.name || "/"}</span>
        {node.media > 0 && <span className="tree-badge">{node.media}</span>}
      </div>
      {hasChildren && isExpanded && (
        <div>
          {node.children.map((c) => (
            <TreeRow
              key={c.path}
              node={c}
              depth={depth + 1}
              expanded={expanded}
              toggle={toggle}
              openIds={openIds}
              activeId={activeId}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function TreeView({
  root,
  openIds,
  activeId,
  onOpen,
}: {
  root: TreeNode;
  openIds: string[];
  activeId: string | null;
  onOpen: (boardId: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const s = new Set<string>([root.path]);
    for (const c of root.children) s.add(c.path); // expand the first level
    return s;
  });
  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  return (
    <div className="tree">
      <TreeRow
        node={root}
        depth={0}
        expanded={expanded}
        toggle={toggle}
        openIds={openIds}
        activeId={activeId}
        onOpen={onOpen}
      />
    </div>
  );
}
