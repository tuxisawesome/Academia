import { ContextMenu } from "radix-ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  BookOpen,
  BookmarkPlus,
  Bookmark as BookmarkIcon,
  Download,
  FilePlus2,
  FolderInput,
  MoreHorizontal,
  MoveHorizontal,
  PanelRight,
  Pencil,
  RotateCcw,
  RotateCw,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
  MousePointerSquareDashed,
} from "lucide-react";
import {
  addPagesToBookmark,
  createBookmark,
  deletePages,
  downloadNode,
  moveNodes,
  renameNode,
  reorderPages,
  rotatePages,
  trashNodes,
  undeletePages,
  restoreNodes,
} from "../../api/actions";
import { ApiError } from "../../api/client";
import { useNotebook } from "../../api/queries";
import type { NotebookDetail } from "../../api/types";
import { ContextMenuContent, MenuButton, type MenuEntry } from "../../components/Menu";
import { bookmarkColor } from "../../lib/colors";
import { plural } from "../../lib/format";
import { isEditableTarget, useDocumentTitle, useIsNarrow } from "../../lib/hooks";
import { rangesLabel, toRanges } from "../../lib/ranges";
import { promptDialog } from "../../state/dialogs";
import { toast, toastError } from "../../state/toasts";
import { MoveDialog } from "../explorer/dialogs";
import { Breadcrumbs } from "../explorer/ExplorerPage";
import { PageGrid, useGridZoom, ZOOM_STEPS, type PageGridHandle } from "./PageGrid";
import { PagePreview } from "./PagePreview";

export function NotebookPage() {
  const { id } = useParams();
  const { data: nb, isLoading, error } = useNotebook(id);
  const navigate = useNavigate();
  const narrow = useIsNarrow();
  const gridRef = useRef<PageGridHandle>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useGridZoom("notebook", 1);
  const [panelOpen, setPanelOpen] = useState(() => !window.matchMedia("(max-width: 1100px)").matches);
  const [hoverBookmark, setHoverBookmark] = useState<string | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const [moving, setMoving] = useState(false);
  useDocumentTitle(nb?.name);

  const pages = useMemo(() => nb?.pages ?? [], [nb?.pages]);
  const ordered = pages.filter((p) => selected.has(p.id)).map((p) => p.id);
  const indexOf = useMemo(() => new Map(pages.map((p, i) => [p.id, i])), [pages]);

  useEffect(() => {
    // Drop selections of pages that no longer exist.
    setSelected((prev) => {
      const next = new Set([...prev].filter((pid) => indexOf.has(pid)));
      return next.size === prev.size ? prev : next;
    });
  }, [indexOf]);

  const markers = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const bm of nb?.bookmarks ?? []) {
      const color = bookmarkColor(bm.id);
      for (const pid of bm.page_ids) {
        const list = map.get(pid) ?? [];
        list.push(color);
        map.set(pid, list);
      }
    }
    return map;
  }, [nb?.bookmarks]);

  const highlight = useMemo(() => {
    const bm = nb?.bookmarks.find((b) => b.id === hoverBookmark);
    return bm ? new Set(bm.page_ids) : null;
  }, [hoverBookmark, nb?.bookmarks]);

  if (error) {
    return (
      <div className="center-fill">
        <div className="empty">
          <h3>{error instanceof ApiError && error.status === 404 ? "Notebook not found" : "Couldn't load notebook"}</h3>
          <p>It may have been moved to the Trash.</p>
          <Link to="/">Go to your library</Link>
        </div>
      </div>
    );
  }
  if (isLoading || !nb) {
    return (
      <div className="center-fill">
        <div className="spinner lg" />
      </div>
    );
  }

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      toastError(err);
    }
  };

  const selectionLabel = rangesLabel(toRanges(ordered.map((pid) => (indexOf.get(pid) ?? 0) + 1)));

  const rotate = (delta: 90 | -90 | 180) => run(() => rotatePages(nb, ordered, delta));

  const remove = () =>
    run(async () => {
      if (!ordered.length) return;
      const detail = await deletePages(nb, ordered);
      setSelected(new Set());
      const batch = detail.deleted_batch;
      toast(`Deleted ${plural(ordered.length, "page")}.`, {
        duration: 10000,
        action: batch
          ? { label: "Undo", onClick: () => void undeletePages(nb.id, batch).catch(toastError) }
          : undefined,
      });
    });

  const makeBookmark = async () => {
    if (!ordered.length) return;
    const name = await promptDialog({
      title: "New bookmark",
      message: `From ${selectionLabel} of “${nb.name}”. It will be saved next to the notebook.`,
      label: "Name",
      initial: "New bookmark",
      confirmLabel: "Create bookmark",
    });
    if (!name) return;
    await run(async () => {
      const node = await createBookmark(nb.parent_id, name, nb.id, ordered);
      toast(`Bookmark “${node.name}” created.`, {
        action: { label: "Read", onClick: () => navigate(`/read/b/${node.id}`) },
      });
    });
  };

  const addTo = (bookmarkId: string, name: string) =>
    run(async () => {
      await addPagesToBookmark(bookmarkId, ordered);
      toast(`Added ${plural(ordered.length, "page")} to “${name}”.`);
    });

  const readFrom = (index: number) => navigate(`/read/n/${nb.id}?page=${index + 1}`);

  const moveToPosition = async () => {
    if (!ordered.length) return;
    const value = await promptDialog({
      title: "Move pages",
      message: `Move ${plural(ordered.length, "selected page")} so they start at page… (1–${pages.length - ordered.length + 1})`,
      label: "New position",
      initial: String((indexOf.get(ordered[0]) ?? 0) + 1),
      confirmLabel: "Move",
    });
    const target = Number(value);
    if (!value || !Number.isInteger(target)) return;
    const moving = new Set(ordered);
    const rest = pages.filter((p) => !moving.has(p.id)).map((p) => p.id);
    const at = Math.max(0, Math.min(rest.length, target - 1));
    await run(() => reorderPages(nb, [...rest.slice(0, at), ...ordered, ...rest.slice(at)]));
  };

  const pageEntries: MenuEntry[] = ordered.length
    ? [
        { label: "Read from here", icon: <BookOpen />, onSelect: () => readFrom(indexOf.get(ordered[0]) ?? 0) },
        { type: "sep" },
        { label: "Rotate right", icon: <RotateCw />, shortcut: "]", onSelect: () => void rotate(90) },
        { label: "Rotate left", icon: <RotateCcw />, shortcut: "[", onSelect: () => void rotate(-90) },
        { label: "Rotate 180°", icon: <RotateCw />, onSelect: () => void rotate(180) },
        { type: "sep" },
        {
          label: "Insert PDF before",
          icon: <FilePlus2 />,
          onSelect: () => {
            const idx = indexOf.get(ordered[0]) ?? 0;
            navigate(idx === 0 ? `/n/${nb.id}/upload?at=start` : `/n/${nb.id}/upload?after=${pages[idx - 1].id}`);
          },
        },
        {
          label: "Insert PDF after",
          icon: <FilePlus2 />,
          onSelect: () => navigate(`/n/${nb.id}/upload?after=${ordered[ordered.length - 1]}`),
        },
        { label: "Move to position…", icon: <MoveHorizontal />, onSelect: () => void moveToPosition() },
        { type: "sep" },
        { label: "Create bookmark…", icon: <BookmarkPlus />, onSelect: () => void makeBookmark() },
        {
          type: "sub",
          label: "Add to bookmark",
          icon: <BookmarkIcon />,
          disabled: nb.bookmarks.length === 0,
          items: nb.bookmarks.map((b) => ({ label: b.name, onSelect: () => void addTo(b.id, b.name) })),
        },
        { type: "sep" },
        { label: `Delete ${plural(ordered.length, "page")}`, icon: <Trash2 />, shortcut: "Del", danger: true, onSelect: () => void remove() },
      ]
    : [
        { label: "Select all", icon: <MousePointerSquareDashed />, shortcut: "Ctrl+A", onSelect: () => setSelected(new Set(pages.map((p) => p.id))) },
        { label: "Add PDF at end…", icon: <FilePlus2 />, onSelect: () => navigate(`/n/${nb.id}/upload`) },
      ];

  const notebookEntries: MenuEntry[] = [
    {
      label: "Rename",
      icon: <Pencil />,
      onSelect: async () => {
        const name = await promptDialog({ title: "Rename notebook", label: "Name", initial: nb.name, confirmLabel: "Rename" });
        if (name && name !== nb.name) await run(() => renameNode(nb.id, name));
      },
    },
    { label: "New bookmark…", icon: <BookmarkPlus />, disabled: !pages.length, onSelect: () => navigate(`/b/new?notebook=${nb.id}&parent=${nb.parent_id ?? ""}`) },
    { label: "Move to…", icon: <FolderInput />, onSelect: () => setMoving(true) },
    { type: "sep" },
    {
      label: "Move to Trash",
      icon: <Trash2 />,
      danger: true,
      onSelect: () =>
        void run(async () => {
          await trashNodes([nb.id]);
          toast(`“${nb.name}” moved to Trash.`, {
            action: { label: "Undo", onClick: () => void restoreNodes([nb.id]).catch(toastError) },
          });
          navigate(nb.parent_id ? `/f/${nb.parent_id}` : "/");
        }),
    },
  ];

  function onKeyDown(e: React.KeyboardEvent) {
    if (isEditableTarget(e.target)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelected(new Set(pages.map((p) => p.id)));
    } else if (e.key === "Escape") setSelected(new Set());
    else if ((e.key === "Delete" || e.key === "Backspace") && ordered.length) {
      e.preventDefault();
      void remove();
    } else if (e.key === "]" && ordered.length) void rotate(90);
    else if (e.key === "[" && ordered.length) void rotate(-90);
    else if (e.key === "Enter" && ordered.length) readFrom(indexOf.get(ordered[0]) ?? 0);
  }

  return (
    <div className="notebook-page" onKeyDown={onKeyDown}>
      <header className="nb-header">
        <Breadcrumbs path={nb.path.slice(0, -1)} />
        <div className="nb-title-row">
          <div className="nb-title">
            <h1 className="truncate">{nb.name}</h1>
            <span className="muted tabular">
              {plural(nb.page_count, "page")}
              {nb.bookmarks.length > 0 && ` · ${plural(nb.bookmarks.length, "bookmark")}`}
              {nb.trashed_at && " · in Trash"}
            </span>
          </div>
          <div className="nb-actions">
            <button className="btn btn-primary" disabled={!pages.length} onClick={() => navigate(`/read/n/${nb.id}`)}>
              <BookOpen /> Read
            </button>
            <button className="btn" onClick={() => navigate(`/n/${nb.id}/upload`)}>
              <FilePlus2 /> {!narrow && "Add PDF"}
            </button>
            <button className="btn" disabled={!pages.length} onClick={() => downloadNode(nb)} title="Download PDF with bookmarks">
              <Download /> {!narrow && "Download"}
            </button>
            <MenuButton entries={notebookEntries} label="Notebook actions">
              <MoreHorizontal />
            </MenuButton>
          </div>
        </div>
      </header>

      <div className="nb-toolbar">
        {ordered.length > 0 ? (
          <>
            <span className="sel-count tabular">
              {plural(ordered.length, "page")} selected <span className="faint">({selectionLabel})</span>
            </span>
            <button className="icon-btn" title="Rotate left ([)" aria-label="Rotate left" onClick={() => void rotate(-90)}>
              <RotateCcw />
            </button>
            <button className="icon-btn" title="Rotate right (])" aria-label="Rotate right" onClick={() => void rotate(90)}>
              <RotateCw />
            </button>
            <button className="icon-btn" title="Delete (Del)" aria-label="Delete pages" onClick={() => void remove()}>
              <Trash2 />
            </button>
            <button className="btn btn-sm" onClick={() => void makeBookmark()}>
              <BookmarkPlus /> {!narrow && "Bookmark"}
            </button>
            <MenuButton entries={pageEntries} label="More page actions">
              <MoreHorizontal />
            </MenuButton>
            <button className="icon-btn" aria-label="Clear selection" title="Clear selection (Esc)" onClick={() => setSelected(new Set())}>
              <X />
            </button>
          </>
        ) : (
          <span className="faint hint">
            {pages.length
              ? narrow
                ? "Tap pages to select them."
                : "Click to select pages · drag to reorder · right-click for more"
              : ""}
          </span>
        )}
        <div className="nb-toolbar-right">
          <button className="icon-btn" aria-label="Smaller thumbnails" disabled={zoom === 0} onClick={() => setZoom(zoom - 1)}>
            <ZoomOut />
          </button>
          <button
            className="icon-btn"
            aria-label="Larger thumbnails"
            disabled={zoom === ZOOM_STEPS.length - 1}
            onClick={() => setZoom(zoom + 1)}
          >
            <ZoomIn />
          </button>
          <button
            className="icon-btn"
            aria-label="Bookmarks panel"
            aria-pressed={panelOpen}
            title="Bookmarks in this notebook"
            onClick={() => setPanelOpen(!panelOpen)}
          >
            <PanelRight />
          </button>
        </div>
      </div>

      <div className="nb-body">
        {pages.length === 0 ? (
          <div className="center-fill">
            <div className="empty">
              <h3>No pages yet</h3>
              <p>Add a PDF to start this notebook.</p>
              <button className="btn btn-primary" onClick={() => navigate(`/n/${nb.id}/upload`)}>
                <FilePlus2 /> Add PDF
              </button>
            </div>
          </div>
        ) : (
          <ContextMenu.Root>
            <ContextMenu.Trigger asChild>
              <div className="nb-grid-wrap">
                <PageGrid
                  ref={gridRef}
                  pages={pages}
                  mode="edit"
                  selected={selected}
                  onSelectedChange={setSelected}
                  tileWidth={ZOOM_STEPS[zoom]}
                  markers={markers}
                  highlight={highlight}
                  onReorder={(order) => void run(() => reorderPages(nb, order))}
                  onOpen={readFrom}
                  onPreview={setPreview}
                  onPageContextMenu={(pid) => {
                    if (pid && !selected.has(pid)) setSelected(new Set([pid]));
                  }}
                  ariaLabel={`Pages of ${nb.name}`}
                />
              </div>
            </ContextMenu.Trigger>
            <ContextMenuContent entries={pageEntries} />
          </ContextMenu.Root>
        )}
        {panelOpen && (
          <BookmarksPanel
            nb={nb}
            onHover={setHoverBookmark}
            onSelect={(ids) => {
              setSelected(new Set(ids));
              if (ids.length) gridRef.current?.scrollToIndex(indexOf.get(ids[0]) ?? 0);
            }}
            onClose={() => setPanelOpen(false)}
          />
        )}
      </div>
      {preview !== null && (
        <PagePreview
          pages={pages}
          index={preview}
          onIndexChange={setPreview}
          onClose={() => setPreview(null)}
          labelFor={(i) => `Page ${i + 1} of ${pages.length}`}
        />
      )}
      <MoveDialog
        targets={moving ? [nb] : null}
        onClose={() => setMoving(false)}
        onMove={async (dest) => {
          await moveNodes([nb.id], dest);
          toast(`Moved “${nb.name}”.`);
        }}
      />
    </div>
  );
}

function BookmarksPanel({
  nb,
  onHover,
  onSelect,
  onClose,
}: {
  nb: NotebookDetail;
  onHover: (id: string | null) => void;
  onSelect: (pageIds: string[]) => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  return (
    <aside className="nb-panel" aria-label="Bookmarks in this notebook">
      <header>
        <h3>Bookmarks</h3>
        <button className="icon-btn icon-btn-sm" aria-label="Close panel" onClick={onClose}>
          <X />
        </button>
      </header>
      {nb.bookmarks.length === 0 ? (
        <p className="muted panel-empty">
          No bookmarks point into this notebook yet. Select pages and choose <strong>Bookmark</strong> to create one.
        </p>
      ) : (
        <ul>
          {nb.bookmarks.map((bm) => (
            <li key={bm.id} onMouseEnter={() => onHover(bm.id)} onMouseLeave={() => onHover(null)}>
              <button className="bm-row" onClick={() => onSelect(bm.page_ids)} title="Select these pages">
                <span className="bm-swatch" style={{ background: bookmarkColor(bm.id) }} />
                <span className="bm-text">
                  <span className="truncate">{bm.name}</span>
                  <small className="truncate tabular">{bm.label}</small>
                </span>
              </button>
              <div className="bm-actions">
                <button
                  className="icon-btn icon-btn-sm"
                  aria-label={`Read ${bm.name}`}
                  title="Read"
                  disabled={!bm.page_ids.length}
                  onClick={() => navigate(`/read/b/${bm.id}`)}
                >
                  <BookOpen />
                </button>
                <button
                  className="icon-btn icon-btn-sm"
                  aria-label={`Edit ${bm.name}`}
                  title="Edit pages"
                  onClick={() => navigate(`/b/${bm.id}/edit`)}
                >
                  <Pencil />
                </button>
                <button
                  className="icon-btn icon-btn-sm"
                  aria-label={`Download ${bm.name}`}
                  title="Download PDF"
                  disabled={!bm.page_ids.length}
                  onClick={() => downloadNode({ id: bm.id, kind: "bookmark" })}
                >
                  <Download />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
