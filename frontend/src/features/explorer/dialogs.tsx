import { useMemo, useState } from "react";
import { ChevronRight, FolderPlus, Library, Search } from "lucide-react";
import { createFolder } from "../../api/actions";
import { useAllNotebooks, useNode, useTree } from "../../api/queries";
import type { LibraryNode } from "../../api/types";
import { FolderGlyph, NodeGlyph } from "../../components/Glyphs";
import { Modal } from "../../components/Modal";
import { PageThumb } from "../../components/PageThumb";
import { formatDateLong, plural } from "../../lib/format";
import { promptDialog } from "../../state/dialogs";
import { toastError } from "../../state/toasts";
import { buildTree, type TreeNode } from "../../layout/FolderTree";

// ---- Folder picker ---------------------------------------------------------------------

function PickerRow({
  node,
  depth,
  value,
  onChange,
  disabled,
  expanded,
  toggle,
}: {
  node: TreeNode;
  depth: number;
  value: string | null;
  onChange: (id: string) => void;
  disabled: Set<string>;
  expanded: Set<string>;
  toggle: (id: string) => void;
}) {
  const isDisabled = disabled.has(node.id);
  const open = expanded.has(node.id);
  return (
    <>
      <div
        className={`picker-row ${value === node.id ? "selected" : ""} ${isDisabled ? "disabled" : ""}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        role="treeitem"
        aria-selected={value === node.id}
        aria-disabled={isDisabled}
        onClick={() => !isDisabled && onChange(node.id)}
      >
        <button
          className={`tree-toggle ${open ? "open" : ""}`}
          style={{ visibility: node.children.length ? "visible" : "hidden" }}
          onClick={(e) => {
            e.stopPropagation();
            toggle(node.id);
          }}
          aria-label={open ? "Collapse" : "Expand"}
        >
          <ChevronRight size={14} />
        </button>
        <FolderGlyph color={node.color} size={18} />
        <span className="truncate">{node.name}</span>
      </div>
      {open &&
        node.children.map((child) => (
          <PickerRow
            key={child.id}
            node={child}
            depth={depth + 1}
            value={value}
            onChange={onChange}
            disabled={disabled}
            expanded={expanded}
            toggle={toggle}
          />
        ))}
    </>
  );
}

/** Picks a destination folder (null = Library root). Folders in `excludeIds` (and inside them) can't be chosen. */
export function FolderPicker({
  value,
  onChange,
  excludeIds = [],
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  excludeIds?: string[];
}) {
  const { data: folders } = useTree();
  const { roots, byId } = useMemo(() => buildTree(folders ?? []), [folders]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const disabled = useMemo(() => {
    const out = new Set<string>();
    const walk = (n: TreeNode) => {
      out.add(n.id);
      n.children.forEach(walk);
    };
    for (const id of excludeIds) {
      const n = byId.get(id);
      if (n) walk(n);
    }
    return out;
  }, [excludeIds, byId]);
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="folder-picker" role="tree">
      <div
        className={`picker-row ${value === null ? "selected" : ""}`}
        role="treeitem"
        aria-selected={value === null}
        onClick={() => onChange(null)}
      >
        <Library size={18} />
        <span>Library</span>
      </div>
      {roots.map((node) => (
        <PickerRow
          key={node.id}
          node={node}
          depth={1}
          value={value}
          onChange={onChange}
          disabled={disabled}
          expanded={expanded}
          toggle={toggle}
        />
      ))}
    </div>
  );
}

export function MoveDialog({
  targets,
  onClose,
  onMove,
  title = "Move to",
  confirmLabel = "Move here",
}: {
  targets: LibraryNode[] | null;
  onClose: () => void;
  onMove: (folderId: string | null) => Promise<void>;
  title?: string;
  confirmLabel?: string;
}) {
  const [dest, setDest] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!targets) return null;
  const excluded = targets.filter((t) => t.kind === "folder").map((t) => t.id);
  const label = targets.length === 1 ? `“${targets[0].name}”` : plural(targets.length, "item");
  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={title}
      description={`Choose where to put ${label}.`}
      size="wide"
      footer={
        <>
          <button
            className="btn btn-ghost"
            onClick={async () => {
              const name = await promptDialog({ title: "New folder", label: "Name", initial: "New folder" });
              if (!name) return;
              try {
                const folder = await createFolder(dest, name);
                setDest(folder.id);
              } catch (err) {
                toastError(err);
              }
            }}
          >
            <FolderPlus /> New folder
          </button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onMove(dest);
                onClose();
              } catch (err) {
                toastError(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <FolderPicker value={dest} onChange={setDest} excludeIds={excluded} />
    </Modal>
  );
}

// ---- Properties ------------------------------------------------------------------------

const KIND_LABEL = { folder: "Folder", notebook: "Notebook", bookmark: "Bookmark" } as const;

export function PropertiesDialog({ node, onClose }: { node: LibraryNode | null; onClose: () => void }) {
  const { data: detail } = useNode(node?.id);
  if (!node) return null;
  const item = detail ?? node;
  const location = detail?.path
    ? ["Library", ...detail.path.slice(0, -1).map((p) => p.name)].join(" / ")
    : "…";
  const rows: [string, React.ReactNode][] = [
    ["Type", KIND_LABEL[item.kind]],
    ["Location", location],
  ];
  if (item.kind === "folder") rows.push(["Contains", plural(item.child_count ?? 0, "item")]);
  if (item.kind === "notebook") rows.push(["Pages", (item.page_count ?? 0).toLocaleString()]);
  if (item.kind === "bookmark") {
    rows.push(["Notebook", item.notebook_name ?? "—"]);
    rows.push(["Pages", `${item.label ?? ""} (${plural(item.page_count ?? 0, "page")})`]);
    if (!item.available) rows.push(["Status", "Notebook is in the Trash"]);
  }
  rows.push(["Created", formatDateLong(item.created_at)]);
  rows.push(["Modified", formatDateLong(item.updated_at)]);
  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={
        <span className="props-title">
          <NodeGlyph kind={item.kind} color={item.color} size={26} />
          <span className="truncate">{item.name}</span>
        </span>
      }
      footer={
        <button className="btn btn-primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="props">
        {item.cover && (
          <div className="props-cover">
            <PageThumb page={item.cover} boxWidth={120} boxHeight={150} eager />
          </div>
        )}
        <dl>
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Modal>
  );
}

// ---- New bookmark: choose a notebook ---------------------------------------------------

export function ChooseNotebookDialog({
  open,
  onClose,
  onChoose,
}: {
  open: boolean;
  onClose: () => void;
  onChoose: (notebook: LibraryNode) => void;
}) {
  const { data: notebooks, isLoading } = useAllNotebooks(open);
  const [filter, setFilter] = useState("");
  if (!open) return null;
  const q = filter.trim().toLowerCase();
  const shown = (notebooks ?? []).filter(
    (n) => !q || n.name.toLowerCase().includes(q) || (n.location ?? "").toLowerCase().includes(q),
  );
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="New bookmark"
      description="Choose the notebook this bookmark points into."
      size="wide"
      footer={
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
      }
    >
      <div className="search-box" style={{ maxWidth: "none", marginBottom: 12 }}>
        <Search aria-hidden="true" />
        <input
          autoFocus
          type="search"
          placeholder="Filter notebooks"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="notebook-choices">
        {isLoading && <div className="spinner" />}
        {!isLoading && shown.length === 0 && <p className="muted">No notebooks found.</p>}
        {shown.map((nb) => (
          <button key={nb.id} className="notebook-choice" onClick={() => onChoose(nb)} disabled={!nb.page_count}>
            {nb.cover ? (
              <PageThumb page={nb.cover} boxWidth={36} boxHeight={46} />
            ) : (
              <NodeGlyph kind="notebook" size={30} />
            )}
            <span className="nc-text">
              <span className="truncate">{nb.name}</span>
              <small className="truncate">
                {nb.location || "Library"} · {plural(nb.page_count ?? 0, "page")}
              </small>
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
