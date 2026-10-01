import { ContextMenu } from "radix-ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  BookmarkPlus,
  ChevronRight,
  FolderInput,
  FolderPlus,
  LayoutGrid,
  List,
  MoreHorizontal,
  NotebookPen,
  Pencil,
  Plus,
  Trash2,
  Upload,
  UploadCloud,
  X,
} from "lucide-react";
import { renameNode } from "../../api/actions";
import { useFolder, useMe } from "../../api/queries";
import type { LibraryNode, PathEntry, SortKey } from "../../api/types";
import { FolderGlyph } from "../../components/Glyphs";
import { ContextMenuContent, MenuButton, type MenuEntry } from "../../components/Menu";
import { plural } from "../../lib/format";
import { isEditableTarget, useDocumentTitle, useIsCoarse, useIsNarrow } from "../../lib/hooks";
import { useFolderDrop } from "../../layout/FolderTree";
import { useClipboard } from "../../state/clipboard";
import { isFileDrag } from "../../state/drag";
import { toastError } from "../../state/toasts";
import { uploadAsNotebooks } from "../../state/uploads";
import { GridView, ListView } from "./ItemViews";
import { useNodeActions } from "./nodeActions";
import { sortNodes } from "./sorting";
import { useMarquee } from "./useMarquee";
import { useSelection } from "./useSelection";

function Crumb({ entry, last }: { entry: PathEntry | null; last: boolean }) {
  const drop = useFolderDrop(entry?.id ?? null, entry?.name ?? "Library");
  const to = entry ? `/f/${entry.id}` : "/";
  return (
    <li className={`crumb ${drop.over ? "drop-over" : ""}`} {...drop.props}>
      {last ? (
        <span aria-current="page">{entry ? entry.name : "Library"}</span>
      ) : (
        <Link to={to}>{entry ? entry.name : "Library"}</Link>
      )}
    </li>
  );
}

export function Breadcrumbs({ path }: { path: PathEntry[] }) {
  const narrow = useIsNarrow();
  const shown = narrow && path.length > 2 ? path.slice(-2) : path;
  return (
    <nav aria-label="Breadcrumb">
      <ol className="breadcrumbs">
        <Crumb entry={null} last={path.length === 0} />
        {narrow && path.length > 2 && (
          <li className="crumb">
            <ChevronRight className="sep" size={14} />
            <span className="faint">…</span>
          </li>
        )}
        {shown.map((entry, i) => (
          <li key={entry.id} className="crumb-wrap">
            <ChevronRight className="sep" size={14} />
            <ol className="breadcrumbs inner">
              <Crumb entry={entry} last={i === shown.length - 1} />
            </ol>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function ExplorerPage() {
  const { folderId } = useParams();
  const currentFolder = folderId ?? null;
  const { data: me } = useMe();
  const { data, isLoading, error } = useFolder(currentFolder);
  const navigate = useNavigate();
  const coarse = useIsCoarse();
  const narrow = useIsNarrow();
  const clipboard = useClipboard();
  const contentRef = useRef<HTMLDivElement>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [menuTargets, setMenuTargets] = useState<LibraryNode[] | "background">("background");
  const [fileDragOver, setFileDragOver] = useState(false);
  const marqueeBase = useRef<Set<string>>(new Set());

  const savedSort = me?.prefs.sort;
  const sort = useMemo(() => savedSort ?? { key: "name" as SortKey, dir: "asc" as const }, [savedSort]);
  const view = me?.prefs.view ?? "grid";
  const items = useMemo(() => sortNodes(data?.items ?? [], sort), [data?.items, sort]);
  const orderedIds = useMemo(() => items.map((i) => i.id), [items]);
  const selection = useSelection(orderedIds);
  const selectedNodes = items.filter((i) => selection.selected.has(i.id));
  const cutIds = useMemo(
    () => new Set(clipboard.mode === "cut" ? clipboard.ids : []),
    [clipboard.mode, clipboard.ids],
  );

  useDocumentTitle(data?.folder?.name ?? "Library");

  const actions = useNodeActions({
    folderId: currentFolder,
    siblingNames: items.map((i) => i.name),
    startRename: setRenamingId,
    onRemoved: selection.clear,
  });

  // Reset per-folder state when navigating.
  useEffect(() => {
    selection.clear();
    setRenamingId(null);
    contentRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFolder]);

  const marquee = useMarquee(contentRef, {
    onStart: () => {
      marqueeBase.current = new Set(selection.selected);
    },
    onChange: (hits, additive) => selection.set(additive ? [...marqueeBase.current, ...hits] : hits),
    onClickEmpty: selection.clear,
  });

  const onRenameDone = async (id: string, name: string | null) => {
    setRenamingId(null);
    contentRef.current?.focus({ preventScroll: true });
    const node = items.find((i) => i.id === id);
    if (!name || !node || name === node.name) return;
    try {
      await renameNode(id, name);
    } catch (err) {
      toastError(err);
    }
  };

  const onSort = (key: SortKey) =>
    actions.setSort(key === sort.key ? { dir: sort.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });

  function onKeyDown(e: React.KeyboardEvent) {
    if (isEditableTarget(e.target) || renamingId) return;
    const mod = e.ctrlKey || e.metaKey;
    const single = selectedNodes.length === 1 ? selectedNodes[0] : null;
    const key = e.key.toLowerCase();
    if (mod && key === "a") {
      e.preventDefault();
      selection.selectAll();
    } else if (mod && key === "c" && selectedNodes.length) {
      e.preventDefault();
      actions.copy(selectedNodes);
    } else if (mod && key === "x" && selectedNodes.length) {
      e.preventDefault();
      actions.cut(selectedNodes);
    } else if (mod && key === "v") {
      e.preventDefault();
      void actions.paste();
    } else if (mod && e.shiftKey && key === "n") {
      e.preventDefault();
      void actions.newFolder();
    } else if ((e.key === "Delete" || (e.metaKey && e.key === "Backspace")) && selectedNodes.length) {
      e.preventDefault();
      void actions.trash(selectedNodes);
    } else if (e.key === "F2" && single) {
      e.preventDefault();
      setRenamingId(single.id);
    } else if (e.key === "Enter" && selectedNodes.length) {
      e.preventDefault();
      actions.open(selectedNodes[0]);
    } else if (e.key === "Escape") {
      if (selectedNodes.length) selection.clear();
      else if (clipboard.mode) clipboard.clear();
    } else if ((e.key === "Backspace" || (e.altKey && e.key === "ArrowUp")) && data?.folder) {
      e.preventDefault();
      navigate(data.folder.parent_id ? `/f/${data.folder.parent_id}` : "/");
    } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key) && items.length) {
      e.preventDefault();
      const current = selection.focused && orderedIds.includes(selection.focused) ? orderedIds.indexOf(selection.focused) : -1;
      let cols = 1;
      if (view === "grid") {
        const tiles = contentRef.current?.querySelectorAll<HTMLElement>(".tile") ?? [];
        const firstTop = tiles[0]?.offsetTop;
        cols = Math.max(1, [...tiles].filter((t) => t.offsetTop === firstTop).length);
      }
      const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[e.key as "ArrowLeft"] ?? 0;
      let next = current < 0 ? 0 : current + delta;
      if (e.key === "Home") next = 0;
      if (e.key === "End") next = items.length - 1;
      if (view === "list" && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return;
      next = Math.max(0, Math.min(items.length - 1, next));
      const id = orderedIds[next];
      selection.click(id, { shiftKey: e.shiftKey, ctrlKey: false });
      document.getElementById(`node-${id}`)?.scrollIntoView({ block: "nearest" });
    }
  }

  function onContextMenu(e: React.MouseEvent) {
    if (isEditableTarget(e.target)) return;
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-node-id]");
    if (el) {
      const id = el.dataset.nodeId!;
      if (!selection.selected.has(id)) {
        selection.selectOnly(id);
        setMenuTargets(items.filter((i) => i.id === id));
      } else {
        setMenuTargets(selectedNodes);
      }
    } else {
      selection.clear();
      setMenuTargets("background");
    }
  }

  const menuEntries: MenuEntry[] =
    menuTargets === "background"
      ? actions.backgroundEntries({ selectAll: selection.selectAll, folder: data?.folder })
      : actions.itemEntries(menuTargets);

  const newEntries: MenuEntry[] = [
    { label: "Folder", icon: <FolderPlus />, shortcut: "Ctrl+Shift+N", onSelect: () => void actions.newFolder() },
    { label: "Notebook", icon: <NotebookPen />, onSelect: () => void actions.newNotebook() },
    { label: "Bookmark…", icon: <BookmarkPlus />, onSelect: () => actions.newBookmark() },
  ];

  if (error) {
    return (
      <div className="center-fill">
        <div className="empty">
          <h3>Folder not found</h3>
          <p>It may have been moved to the Trash.</p>
          <Link to="/">Go to your library</Link>
        </div>
      </div>
    );
  }

  const viewProps = {
    items,
    selection,
    actions,
    folderId: currentFolder,
    renamingId,
    onRenameDone,
    cutIds,
    touch: coarse,
    sort,
    onSort,
  };

  const single = selectedNodes.length === 1 ? selectedNodes[0] : null;

  return (
    <div className="explorer">
      <div className="explorer-bar">
        <Breadcrumbs path={data?.path ?? []} />
        <div className="explorer-actions">
          {selectedNodes.length > 0 && !narrow ? (
            <div className="selection-actions">
              <span className="sel-count">{plural(selectedNodes.length, "item")} selected</span>
              {single && (
                <button className="icon-btn" title="Rename (F2)" aria-label="Rename" onClick={() => setRenamingId(single.id)}>
                  <Pencil />
                </button>
              )}
              <button className="icon-btn" title="Move to…" aria-label="Move to" onClick={() => actions.moveTo(selectedNodes)}>
                <FolderInput />
              </button>
              <button className="icon-btn" title="Delete (Del)" aria-label="Delete" onClick={() => void actions.trash(selectedNodes)}>
                <Trash2 />
              </button>
              <MenuButton entries={actions.itemEntries(selectedNodes)} label="More actions">
                <MoreHorizontal />
              </MenuButton>
              <button className="icon-btn" title="Clear selection (Esc)" aria-label="Clear selection" onClick={selection.clear}>
                <X />
              </button>
              <span className="bar-sep" />
            </div>
          ) : null}
          <MenuButton entries={newEntries} label="New" className="btn btn-primary" align="start">
            <Plus /> {!narrow && "New"}
          </MenuButton>
          <button className="btn" onClick={() => actions.upload()} title="Upload PDFs as new notebooks">
            <Upload /> {!narrow && "Upload"}
          </button>
          <div className="segmented" role="group" aria-label="View">
            <button aria-pressed={view === "grid"} onClick={() => void actions.setView("grid")} title="Grid view">
              <LayoutGrid />
            </button>
            <button aria-pressed={view === "list"} onClick={() => void actions.setView("list")} title="List view">
              <List />
            </button>
          </div>
        </div>
      </div>

      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div
            ref={contentRef}
            className={`explorer-content ${fileDragOver ? "file-drag" : ""}`}
            tabIndex={0}
            aria-activedescendant={selection.focused ? `node-${selection.focused}` : undefined}
            onKeyDown={onKeyDown}
            onContextMenu={onContextMenu}
            onDragOver={(e) => {
              if (isFileDrag(e)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                setFileDragOver(true);
              }
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setFileDragOver(false);
            }}
            onDrop={(e) => {
              setFileDragOver(false);
              if (isFileDrag(e)) {
                e.preventDefault();
                void uploadAsNotebooks([...e.dataTransfer.files], currentFolder);
              }
            }}
            {...marquee.handlers}
          >
            {isLoading ? (
              <div className="center-fill">
                <div className="spinner lg" />
              </div>
            ) : items.length === 0 ? (
              <div className="center-fill no-marquee-inner">
                <div className="empty">
                  <FolderGlyph color={data?.folder?.color} size={64} />
                  <h3>{data?.folder ? "This folder is empty" : "Your library is empty"}</h3>
                  <p>
                    Create a folder or notebook, or drop PDF files here — each becomes a notebook.
                  </p>
                  <div className="empty-actions">
                    <button className="btn" onClick={() => void actions.newFolder()}>
                      <FolderPlus /> New folder
                    </button>
                    <button className="btn btn-primary" onClick={() => actions.upload()}>
                      <Upload /> Upload PDFs
                    </button>
                  </div>
                </div>
              </div>
            ) : view === "grid" ? (
              <GridView {...viewProps} />
            ) : (
              <ListView {...viewProps} />
            )}
            {marquee.rect && (
              <div
                className="marquee"
                style={{
                  left: marquee.rect.left,
                  top: marquee.rect.top,
                  width: marquee.rect.width,
                  height: marquee.rect.height,
                }}
              />
            )}
            {fileDragOver && (
              <div className="file-drop-hint">
                <UploadCloud />
                <span>Drop PDFs to add them to {data?.folder ? `“${data.folder.name}”` : "your library"}</span>
              </div>
            )}
          </div>
        </ContextMenu.Trigger>
        <ContextMenuContent entries={menuEntries} />
      </ContextMenu.Root>

      {narrow && selectedNodes.length > 0 && (
        <div className="mobile-actionbar">
          <span>{plural(selectedNodes.length, "selected", "selected")}</span>
          <button className="icon-btn" aria-label="Move to" onClick={() => actions.moveTo(selectedNodes)}>
            <FolderInput />
          </button>
          <button className="icon-btn" aria-label="Delete" onClick={() => void actions.trash(selectedNodes)}>
            <Trash2 />
          </button>
          <MenuButton entries={actions.itemEntries(selectedNodes)} label="More actions" align="end">
            <MoreHorizontal />
          </MenuButton>
          <button className="icon-btn" aria-label="Clear selection" onClick={selection.clear}>
            <X />
          </button>
        </div>
      )}

      <div className="statusbar">
        <span>{plural(items.length, "item")}</span>
        {selectedNodes.length > 0 && <span>{plural(selectedNodes.length, "item")} selected</span>}
        {clipboard.mode && (
          <span className="faint">
            {plural(clipboard.ids.length, "item")} on clipboard ({clipboard.mode})
          </span>
        )}
      </div>
      {actions.dialogs}
    </div>
  );
}
