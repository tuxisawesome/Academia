import { DropdownMenu } from "radix-ui";
import { ArrowDown, ArrowUp, MoreHorizontal } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import type { LibraryNode, Prefs, SortKey } from "../../api/types";
import { BookmarkGlyph, FolderGlyph, NodeGlyph, NotebookGlyph } from "../../components/Glyphs";
import { DropdownMenuContent } from "../../components/Menu";
import { PageThumb } from "../../components/PageThumb";
import { formatDate, plural } from "../../lib/format";
import { useFolderDrop } from "../../layout/FolderTree";
import { endNodeDrag, isFileDrag, startNodeDrag } from "../../state/drag";
import { appendToNotebook } from "../../state/uploads";
import { toast } from "../../state/toasts";
import type { NodeActions } from "./nodeActions";
import type { Selection } from "./useSelection";

export function metaLine(node: LibraryNode): string {
  if (node.kind === "folder") return plural(node.child_count ?? 0, "item");
  if (node.kind === "notebook") return node.page_count ? plural(node.page_count, "page") : "Empty";
  if (!node.available) return "Notebook in Trash";
  return node.label ?? "";
}

const KIND_LABEL = { folder: "Folder", notebook: "Notebook", bookmark: "Bookmark" } as const;

export interface ItemViewProps {
  items: LibraryNode[];
  selection: Selection;
  actions: NodeActions;
  folderId: string | null;
  renamingId: string | null;
  onRenameDone: (id: string, name: string | null) => void;
  cutIds: Set<string>;
  touch: boolean;
  /** Extra columns for special listings. */
  variant?: "folder" | "search" | "trash";
  sort?: Prefs["sort"];
  onSort?: (key: SortKey) => void;
  /** Called for activation (double-click / tap). */
  onOpen?: (node: LibraryNode) => void;
  entriesFor?: (targets: LibraryNode[]) => ReturnType<NodeActions["itemEntries"]>;
}

function RenameInput({ node, onDone }: { node: LibraryNode; onDone: (name: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const input = ref.current;
    if (input) {
      input.focus();
      input.select();
    }
  }, []);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  return (
    <input
      ref={ref}
      className="rename-input"
      defaultValue={node.name}
      maxLength={255}
      aria-label="New name"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(e.currentTarget.value.trim() || null);
        if (e.key === "Escape") finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value.trim() || null)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}

function MoreButton({ node, props }: { node: LibraryNode; props: ItemViewProps }) {
  const [open, setOpen] = useState(false);
  const targets = props.selection.selected.has(node.id)
    ? props.items.filter((i) => props.selection.selected.has(i.id))
    : [node];
  const entries = open ? (props.entriesFor ?? props.actions.itemEntries)(targets) : [];
  return (
    <DropdownMenu.Root
      modal={false}
      open={open}
      onOpenChange={(o) => {
        if (o && !props.selection.selected.has(node.id)) props.selection.selectOnly(node.id);
        setOpen(o);
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          className="item-more icon-btn icon-btn-sm"
          aria-label={`Actions for ${node.name}`}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <MoreHorizontal />
        </button>
      </DropdownMenu.Trigger>
      {open && <DropdownMenuContent entries={entries} />}
    </DropdownMenu.Root>
  );
}

/** Pointer, keyboard and drag behavior shared by grid tiles and list rows. */
function useItemBehavior(node: LibraryNode, props: ItemViewProps) {
  const { selection, touch, actions } = props;
  const selected = selection.selected.has(node.id);
  const selectionMode = touch && selection.selected.size > 0;
  const folderDrop = useFolderDrop(node.kind === "folder" ? node.id : "__never__", node.name);
  const [fileOver, setFileOver] = useState(false);
  const pointerType = useRef<string>("mouse");
  const open = props.onOpen ?? actions.open;

  const dropProps =
    node.kind === "folder" && props.variant !== "trash"
      ? folderDrop.props
      : node.kind === "notebook" && props.variant !== "trash"
        ? {
            onDragOver: (e: React.DragEvent) => {
              if (isFileDrag(e)) {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "copy";
                setFileOver(true);
              }
            },
            onDragLeave: () => setFileOver(false),
            onDrop: (e: React.DragEvent) => {
              if (!isFileDrag(e)) return;
              e.preventDefault();
              e.stopPropagation();
              setFileOver(false);
              const files = [...e.dataTransfer.files];
              toast(`Adding ${plural(files.length, "PDF")} to the end of “${node.name}”…`);
              void appendToNotebook(files, node.id);
            },
          }
        : {};

  return {
    selected,
    dropOver: folderDrop.over || fileOver,
    handlers: {
      "data-node-id": node.id,
      id: `node-${node.id}`,
      role: "option",
      "aria-selected": selected,
      draggable: props.variant !== "trash" && props.renamingId !== node.id,
      onPointerDown: (e: React.PointerEvent) => {
        pointerType.current = e.pointerType;
      },
      onClick: (e: React.MouseEvent) => {
        e.stopPropagation();
        if (pointerType.current === "touch" && !selectionMode && !(e.target as HTMLElement).closest(".item-check")) {
          open(node);
          return;
        }
        if (selectionMode || (e.target as HTMLElement).closest(".item-check")) selection.toggle(node.id);
        else selection.click(node.id, e);
      },
      onDoubleClick: (e: React.MouseEvent) => {
        e.stopPropagation();
        if (pointerType.current !== "touch") open(node);
      },
      onDragStart: (e: React.DragEvent) => {
        let ids = [node.id];
        if (selected) ids = props.items.filter((i) => selection.selected.has(i.id)).map((i) => i.id);
        else selection.selectOnly(node.id);
        const folderIds = props.items.filter((i) => ids.includes(i.id) && i.kind === "folder").map((i) => i.id);
        startNodeDrag(e, ids, folderIds, props.folderId, ids.length === 1 ? node.name : plural(ids.length, "item"));
      },
      onDragEnd: () => endNodeDrag(),
      ...dropProps,
    },
  };
}

function Visual({ node }: { node: LibraryNode }) {
  if (node.kind === "folder") {
    return (
      <div className="tile-visual folder">
        <FolderGlyph color={node.color} size={92} />
      </div>
    );
  }
  if (!node.cover) {
    return (
      <div className="tile-visual empty-cover">
        {node.kind === "notebook" ? <NotebookGlyph size={58} /> : <BookmarkGlyph size={52} />}
      </div>
    );
  }
  return (
    <div className={`tile-visual ${node.kind === "notebook" ? "stack" : "marked"} ${node.available === false ? "unavailable" : ""}`}>
      <PageThumb page={node.cover} boxWidth={118} boxHeight={138} />
      {node.kind === "bookmark" && (
        <svg className="ribbon" viewBox="0 0 20 32" aria-hidden="true">
          <path d="M0 0h20v32l-10-8-10 8z" />
        </svg>
      )}
    </div>
  );
}

const Tile = memo(function Tile({ node, props }: { node: LibraryNode; props: ItemViewProps }) {
  const { selected, dropOver, handlers } = useItemBehavior(node, props);
  const cut = props.cutIds.has(node.id);
  return (
    <div
      className={`tile ${selected ? "selected" : ""} ${dropOver ? "drop-over" : ""} ${cut ? "is-cut" : ""}`}
      title={props.renamingId === node.id ? undefined : node.name}
      {...handlers}
    >
      {(props.touch || selected) && (
        <input
          type="checkbox"
          className="item-check"
          checked={selected}
          readOnly
          tabIndex={-1}
          aria-label={`Select ${node.name}`}
        />
      )}
      <Visual node={node} />
      <div className="tile-name">
        {props.renamingId === node.id ? (
          <RenameInput node={node} onDone={(name) => props.onRenameDone(node.id, name)} />
        ) : (
          <span className="clamp-2">{node.name}</span>
        )}
      </div>
      <div className="tile-meta truncate">
        {props.variant === "trash" ? node.original_location : props.variant === "search" ? node.location || "Library" : metaLine(node)}
      </div>
      <MoreButton node={node} props={props} />
    </div>
  );
});

const Row = memo(function Row({ node, props }: { node: LibraryNode; props: ItemViewProps }) {
  const { selected, dropOver, handlers } = useItemBehavior(node, props);
  const cut = props.cutIds.has(node.id);
  const pages =
    node.kind === "folder" ? plural(node.child_count ?? 0, "item") : node.page_count ? plural(node.page_count, "page") : "—";
  return (
    <div
      className={`row ${selected ? "selected" : ""} ${dropOver ? "drop-over" : ""} ${cut ? "is-cut" : ""} ${
        node.available === false ? "unavailable" : ""
      }`}
      {...handlers}
    >
      <div className="cell name">
        {props.touch && (
          <input type="checkbox" className="item-check" checked={selected} readOnly tabIndex={-1} aria-label={`Select ${node.name}`} />
        )}
        <NodeGlyph kind={node.kind} color={node.color} size={22} />
        {props.renamingId === node.id ? (
          <RenameInput node={node} onDone={(name) => props.onRenameDone(node.id, name)} />
        ) : (
          <span className="truncate" title={node.name}>
            {node.name}
          </span>
        )}
        {node.kind === "bookmark" && node.label && props.variant !== "trash" && (
          <span className="row-sub truncate">{node.available ? node.label : "Notebook in Trash"}</span>
        )}
      </div>
      {props.variant === "search" && <div className="cell location truncate">{node.location || "Library"}</div>}
      {props.variant === "trash" && <div className="cell location truncate">{node.original_location}</div>}
      <div className="cell kind">{KIND_LABEL[node.kind]}</div>
      <div className="cell pages tabular">
        {props.variant === "trash" && node.kind === "folder" ? plural(Math.max(0, (node.item_count ?? 1) - 1), "item") : pages}
      </div>
      <div className="cell date tabular">{formatDate(props.variant === "trash" ? node.trashed_at : node.updated_at)}</div>
      <div className="cell more">
        <MoreButton node={node} props={props} />
      </div>
    </div>
  );
});

export function GridView(props: ItemViewProps) {
  return (
    <div className="grid-view" role="listbox" aria-multiselectable="true" aria-label="Items">
      {props.items.map((node) => (
        <Tile key={node.id} node={node} props={props} />
      ))}
    </div>
  );
}

function SortHeader({ label, k, props, className }: { label: string; k: SortKey; props: ItemViewProps; className: string }) {
  const active = props.sort?.key === k;
  return (
    <button
      className={`cell ${className} sort-head ${active ? "active" : ""}`}
      onClick={() => props.onSort?.(k)}
      disabled={!props.onSort}
      aria-sort={active ? (props.sort?.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      {label}
      {active && (props.sort?.dir === "asc" ? <ArrowUp size={13} /> : <ArrowDown size={13} />)}
    </button>
  );
}

export function ListView(props: ItemViewProps) {
  const variant = props.variant ?? "folder";
  return (
    <div className={`list-view variant-${variant}`} role="listbox" aria-multiselectable="true" aria-label="Items">
      <div className="row head" role="presentation">
        <SortHeader label="Name" k="name" props={props} className="name" />
        {variant === "search" && <div className="cell location">Location</div>}
        {variant === "trash" && <div className="cell location">Original location</div>}
        <SortHeader label="Type" k="type" props={props} className="kind" />
        <SortHeader label={variant === "trash" ? "Contents" : "Size"} k="pages" props={props} className="pages" />
        <SortHeader label={variant === "trash" ? "Deleted" : "Modified"} k="modified" props={props} className="date" />
        <div className="cell more" />
      </div>
      {props.items.map((node) => (
        <Row key={node.id} node={node} props={props} />
      ))}
    </div>
  );
}
