import { useEffect, useMemo, useState } from "react";
import { NavLink, useMatch, useNavigate } from "react-router";
import { ChevronRight, Library } from "lucide-react";
import { copyNodes, moveNodes } from "../api/actions";
import { useTree } from "../api/queries";
import type { TreeFolder } from "../api/types";
import { FolderGlyph } from "../components/Glyphs";
import { compareNames, plural } from "../lib/format";
import { canDropInto, currentDrag, dropEffect, endNodeDrag, isFileDrag, isNodeDrag, NODE_MIME } from "../state/drag";
import { toast, toastError } from "../state/toasts";
import { uploadAsNotebooks } from "../state/uploads";

const EXPANDED_KEY = "academia-tree-expanded";

function loadExpanded(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

export interface TreeNode extends TreeFolder {
  children: TreeNode[];
}

export function buildTree(folders: TreeFolder[]): { roots: TreeNode[]; byId: Map<string, TreeNode> } {
  const byId = new Map<string, TreeNode>();
  for (const f of folders) byId.set(f.id, { ...f, children: [] });
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parent_id ? byId.get(node.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (list: TreeNode[]) => {
    list.sort((a, b) => compareNames(a.name, b.name));
    list.forEach((n) => sort(n.children));
  };
  sort(roots);
  return { roots, byId };
}

/** Handlers that make an element a drop target for library items and desktop files. */
export function useFolderDrop(folderId: string | null, folderName: string) {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (e: React.DragEvent) => {
        if (isNodeDrag(e) ? canDropInto(folderId) && currentDrag()?.fromFolder !== folderId : isFileDrag(e)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = isNodeDrag(e) ? dropEffect(e) : "copy";
          if (!over) setOver(true);
        }
      },
      onDragLeave: () => setOver(false),
      onDrop: async (e: React.DragEvent) => {
        setOver(false);
        if (isNodeDrag(e)) {
          e.preventDefault();
          e.stopPropagation();
          const ids: string[] = JSON.parse(e.dataTransfer.getData(NODE_MIME) || "[]");
          const copy = dropEffect(e) === "copy";
          const from = currentDrag()?.fromFolder ?? null;
          endNodeDrag();
          try {
            if (copy) {
              await copyNodes(ids, folderId);
              toast(`Copied ${plural(ids.length, "item")} to ${folderName}.`);
            } else {
              await moveNodes(ids, folderId);
              toast(`Moved ${plural(ids.length, "item")} to ${folderName}.`, {
                action: { label: "Undo", onClick: () => void moveNodes(ids, from).catch(toastError) },
              });
            }
          } catch (err) {
            toastError(err);
          }
        } else if (isFileDrag(e)) {
          e.preventDefault();
          e.stopPropagation();
          void uploadAsNotebooks([...e.dataTransfer.files], folderId);
        }
      },
    },
  };
}

function TreeItem({
  node,
  depth,
  expanded,
  toggle,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  toggle: (id: string) => void;
}) {
  const open = expanded.has(node.id);
  const drop = useFolderDrop(node.id, node.name);
  const navigate = useNavigate();
  return (
    <li role="treeitem" aria-expanded={node.children.length ? open : undefined} aria-selected={false}>
      <div className={`tree-row ${drop.over ? "drop-over" : ""}`} style={{ paddingLeft: 6 + depth * 14 }} {...drop.props}>
        <button
          className={`tree-toggle ${open ? "open" : ""}`}
          aria-label={open ? "Collapse" : "Expand"}
          tabIndex={-1}
          style={{ visibility: node.children.length ? "visible" : "hidden" }}
          onClick={() => toggle(node.id)}
        >
          <ChevronRight size={14} />
        </button>
        <NavLink
          to={`/f/${node.id}`}
          className="tree-link"
          onDoubleClick={() => toggle(node.id)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" && !open && node.children.length) toggle(node.id);
            if (e.key === "ArrowLeft" && open) toggle(node.id);
            if (e.key === "Enter") navigate(`/f/${node.id}`);
          }}
        >
          <FolderGlyph color={node.color} size={18} open={open} />
          <span className="truncate">{node.name}</span>
        </NavLink>
      </div>
      {open && node.children.length > 0 && (
        <ul role="group">
          {node.children.map((child) => (
            <TreeItem key={child.id} node={child} depth={depth + 1} expanded={expanded} toggle={toggle} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function FolderTree() {
  const { data: folders } = useTree();
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded);
  const match = useMatch("/f/:folderId");
  const current = match?.params.folderId;
  const { roots, byId } = useMemo(() => buildTree(folders ?? []), [folders]);
  const rootDrop = useFolderDrop(null, "Library");

  // Reveal the current folder.
  useEffect(() => {
    if (!current || !byId.size) return;
    let node = byId.get(current);
    const toOpen: string[] = [];
    while (node?.parent_id) {
      toOpen.push(node.parent_id);
      node = byId.get(node.parent_id);
    }
    if (toOpen.some((id) => !expanded.has(id))) {
      setExpanded((prev) => new Set([...prev, ...toOpen]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, byId]);

  useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded]));
    } catch {
      /* ignore */
    }
  }, [expanded]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="tree">
      <div className={`tree-row root ${rootDrop.over ? "drop-over" : ""}`} {...rootDrop.props}>
        <NavLink to="/" end className="tree-link">
          <Library size={18} />
          <span>Library</span>
        </NavLink>
      </div>
      <ul role="tree" aria-label="Folders">
        {roots.map((node) => (
          <TreeItem key={node.id} node={node} depth={0} expanded={expanded} toggle={toggle} />
        ))}
      </ul>
    </div>
  );
}
