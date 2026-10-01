import { ContextMenu } from "radix-ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  ArchiveRestore,
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
  Tag,
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
import { ApiError, errorMessage, isNotFound, isPageError } from "../../api/client";
import { invalidateLibrary, queryClient, useNotebook } from "../../api/queries";
import type { NotebookBookmark, NotebookDetail } from "../../api/types";
import { ContextMenuContent, MenuButton, type MenuEntry } from "../../components/Menu";
import { bookmarkColor } from "../../lib/colors";
import { plural } from "../../lib/format";
import { useDocumentTitle, useIsNarrow } from "../../lib/hooks";
import { shortcutKey } from "../../lib/keys";
import { rangesLabel, toRanges } from "../../lib/ranges";
import { promptDialog } from "../../state/dialogs";
import { toast, toastError } from "../../state/toasts";
import { MoveDialog } from "../explorer/dialogs";
import { Breadcrumbs } from "../explorer/ExplorerPage";
import { confirmTrash } from "../explorer/nodeActions";
import { TagPagesDialog, type TagTarget } from "../tags/TagPagesDialog";
import { PageGrid, useGridZoom, ZOOM_STEPS, type PageGridHandle } from "./PageGrid";
import { PagePreview } from "./PagePreview";
import { isPageShortcut } from "./shortcuts";

export function NotebookPage() {
  const { id } = useParams();
  const { data: nb, isLoading, error, refetch } = useNotebook(id);
  const navigate = useNavigate();
  const narrow = useIsNarrow();
  const gridRef = useRef<PageGridHandle>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useGridZoom("notebook", 1);
  const [panelOpen, setPanelOpen] = useState(() => !window.matchMedia("(max-width: 1100px)").matches);
  const [hoverBookmark, setHoverBookmark] = useState<string | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const [moving, setMoving] = useState(false);
  const [tagging, setTagging] = useState<TagTarget | null>(null);
  // Page under the last touch/pen press: Radix opens long-press menus by timer, without a contextmenu event on iOS.
  const pressedPage = useRef<string | null>(null);
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

  if (isPageError(error, !!nb)) {
    return (
      <div className="center-fill">
        {isNotFound(error) ? (
          <div className="empty">
            <h3>Notebook not found</h3>
            <p>It may have been moved to the Trash.</p>
            <Link to="/">Go to your library</Link>
          </div>
        ) : (
          <div className="empty">
            <h3>Couldn't load notebook</h3>
            <p>{errorMessage(error)}</p>
            <button className="btn" onClick={() => void refetch()}>
              Try again
            </button>
          </div>
        )}
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

  // A notebook in the Trash can still be opened (Back, another tab), but the server rejects every change.
  const trashed = Boolean(nb.trashed_at);
  const canAct = !trashed && ordered.length > 0;

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

  const tag = (pageIds: string[], description: string) => {
    const ids = new Set(pageIds);
    const tagged = pages.filter((p) => ids.has(p.id));
    if (tagged.length) setTagging({ notebookId: nb.id, pages: tagged, description });
  };

  const tagSelection = () => tag(ordered, `“${nb.name}”, ${selectionLabel}.`);

  const tagBookmark = (bm: NotebookBookmark) => tag(bm.page_ids, `The pages of the bookmark “${bm.name}” (${bm.label}).`);

  const readFrom = (index: number) => navigate(`/read/n/${nb.id}?page=${index + 1}`);

  const selectForMenu = (pid: string | null) => {
    if (pid && !selected.has(pid)) setSelected(new Set([pid]));
  };

  const restore = async () => {
    try {
      await restoreNodes([nb.id]);
      toast(`Restored “${nb.name}”.`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // Already restored (or purged) elsewhere: the refetch shows that. Otherwise only a trash root can be
        // restored, and a notebook trashed along with its folder comes back with the folder.
        await invalidateLibrary();
        const state = queryClient.getQueryState<NotebookDetail>(["notebook", nb.id]);
        if (state?.status === "error" || !state?.data?.trashed_at) return;
        toast(`“${nb.name}” was moved to the Trash with its folder. Restore the folder from the Trash.`, {
          action: { label: "Open Trash", onClick: () => navigate("/trash") },
        });
      } else toastError(err);
    }
  };

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
        { label: "Tag pages…", icon: <Tag />, shortcut: "T", onSelect: tagSelection },
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
          if (!(await confirmTrash([nb]))) return;
          await trashNodes([nb.id]);
          toast(`“${nb.name}” moved to Trash.`, {
            action: { label: "Undo", onClick: () => void restoreNodes([nb.id]).catch(toastError) },
          });
          navigate(nb.parent_id ? `/f/${nb.parent_id}` : "/");
        }),
    },
  ];

  function onKeyDown(e: React.KeyboardEvent) {
    if (!isPageShortcut(e)) return;
    if ((e.ctrlKey || e.metaKey) && shortcutKey(e) === "a") {
      e.preventDefault();
      setSelected(new Set(pages.map((p) => p.id)));
    } else if (e.key === "Escape") setSelected(new Set());
    else if ((e.key === "Delete" || e.key === "Backspace") && canAct) {
      e.preventDefault();
      void remove();
    } else if (e.key === "]" && canAct) void rotate(90);
    else if (e.key === "[" && canAct) void rotate(-90);
    else if (e.key === "Enter" && canAct) readFrom(indexOf.get(ordered[0]) ?? 0);
    else if (shortcutKey(e) === "t" && !e.ctrlKey && !e.metaKey && !e.altKey && canAct) {
      e.preventDefault();
      tagSelection();
    }
  }

  return (
    <div className="notebook-page" onKeyDown={onKeyDown}>
      <header className="nb-header">
        <Breadcrumbs path={nb.path.slice(0, -1)} linkLast />
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
            {trashed ? (
              <button className="btn btn-primary" onClick={() => void restore()}>
                <ArchiveRestore /> Restore
              </button>
            ) : (
              <>
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
              </>
            )}
          </div>
        </div>
      </header>

      <div className="nb-toolbar">
        {canAct ? (
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
            <button className="btn btn-sm" aria-label="Tag pages" title="Tag pages (T)" onClick={tagSelection}>
              <Tag /> {!narrow && "Tag…"}
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
            {trashed
              ? "This notebook is in the Trash. Restore it to read or change it."
              : pages.length
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
              {!trashed && (
                <>
                  <p>Add a PDF to start this notebook.</p>
                  <button className="btn btn-primary" onClick={() => navigate(`/n/${nb.id}/upload`)}>
                    <FilePlus2 /> Add PDF
                  </button>
                </>
              )}
            </div>
          </div>
        ) : (
          <ContextMenu.Root
            onOpenChange={(open) => {
              if (!open) return;
              selectForMenu(pressedPage.current);
              pressedPage.current = null;
            }}
          >
            <ContextMenu.Trigger asChild disabled={trashed}>
              <div
                className="nb-grid-wrap"
                onPointerDown={(e) => {
                  const tile = (e.target as HTMLElement).closest<HTMLElement>("[data-page-index]");
                  pressedPage.current = e.pointerType !== "mouse" && tile ? pages[Number(tile.dataset.pageIndex)].id : null;
                }}
              >
                <PageGrid
                  ref={gridRef}
                  pages={pages}
                  mode="edit"
                  selected={selected}
                  onSelectedChange={setSelected}
                  tileWidth={ZOOM_STEPS[zoom]}
                  markers={markers}
                  highlight={highlight}
                  onReorder={trashed ? undefined : (order) => void run(() => reorderPages(nb, order))}
                  onOpen={trashed ? undefined : readFrom}
                  onPreview={setPreview}
                  onPageContextMenu={selectForMenu}
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
            onTag={tagBookmark}
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
      <TagPagesDialog target={tagging} onClose={() => setTagging(null)} />
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
  onTag,
  onSelect,
  onClose,
}: {
  nb: NotebookDetail;
  onHover: (id: string | null) => void;
  onTag: (bookmark: NotebookBookmark) => void;
  onSelect: (pageIds: string[]) => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  // A bookmark of a notebook in the Trash can't be read, edited or downloaded until it is restored.
  const inTrash = Boolean(nb.trashed_at);
  const inTrashTitle = (title: string) => (inTrash ? "Restore the notebook first" : title);
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
                  title={inTrashTitle("Read")}
                  disabled={inTrash || !bm.page_ids.length}
                  onClick={() => navigate(`/read/b/${bm.id}`)}
                >
                  <BookOpen />
                </button>
                <button
                  className="icon-btn icon-btn-sm"
                  aria-label={`Edit ${bm.name}`}
                  title={inTrashTitle("Edit pages")}
                  disabled={inTrash}
                  onClick={() => navigate(`/b/${bm.id}/edit`)}
                >
                  <Pencil />
                </button>
                <button
                  className="icon-btn icon-btn-sm"
                  aria-label={`Tag pages of ${bm.name}`}
                  title={inTrashTitle("Tag pages")}
                  disabled={inTrash || !bm.page_ids.length}
                  onClick={() => onTag(bm)}
                >
                  <Tag />
                </button>
                <button
                  className="icon-btn icon-btn-sm"
                  aria-label={`Download ${bm.name}`}
                  title={inTrashTitle("Download PDF")}
                  disabled={inTrash || !bm.page_ids.length}
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
