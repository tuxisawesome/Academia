import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  BookOpen,
  BookmarkPlus,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Download,
  FilePlus2,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Info,
  LayoutGrid,
  List,
  MousePointerSquareDashed,
  NotebookPen,
  Palette,
  Pencil,
  Pin,
  PinOff,
  ArrowDownAZ,
  Scissors,
  Tag,
  Trash2,
  Upload,
  FileSearch,
} from "lucide-react";
import {
  copyNodes,
  createFolder,
  createNotebook,
  liveNodeIds,
  moveBack,
  moveNodes,
  pinFolders,
  renameNode,
  restoreNodes,
  safeDownload,
  setFolderColor,
  trashCheck,
  trashNodes,
  unpinFolders,
  updatePrefs,
} from "../../api/actions";
import { api, ApiError } from "../../api/client";
import { queryClient, useMe, usePins } from "../../api/queries";
import type { BookmarkDetail, FolderColor, LibraryNode, Prefs, SortKey } from "../../api/types";
import type { MenuEntry } from "../../components/Menu";
import { plural } from "../../lib/format";
import { groupByParent } from "../../lib/parents";
import { useClipboard } from "../../state/clipboard";
import { confirmDialog, promptDialog } from "../../state/dialogs";
import { toast, toastError } from "../../state/toasts";
import { uploadAsNotebooks } from "../../state/uploads";
import { TagPagesDialog, type TagTarget } from "../tags/TagPagesDialog";
import { ChooseNotebookDialog, MoveDialog, PropertiesDialog } from "./dialogs";

export function uniqueName(base: string, existing: string[]): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} (${i})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Warns when bookmarks elsewhere point into notebooks among `targets`; false if the user cancels. */
export async function confirmTrash(targets: LibraryNode[]): Promise<boolean> {
  if (!targets.some((t) => t.kind !== "bookmark")) return true;
  const { bookmarks_elsewhere } = await trashCheck(targets.map((t) => t.id));
  if (bookmarks_elsewhere === 0) return true;
  return confirmDialog({
    title: "Move to Trash?",
    message: `${plural(bookmarks_elsewhere, "bookmark")} elsewhere in your library ${
      bookmarks_elsewhere === 1 ? "points" : "point"
    } into ${targets.length === 1 ? "this" : "these"} notebook${
      targets.length === 1 ? "" : "s"
    }. ${bookmarks_elsewhere === 1 ? "It" : "They"} will be unavailable while it's in the Trash, and deleted if the Trash is emptied.`,
    confirmLabel: "Move to Trash",
    danger: true,
  });
}

interface Options {
  /** Folder that "New…" and "Paste" apply to (null = Library root). */
  folderId: string | null;
  /** Names in the current folder, to pick unique default names. */
  siblingNames?: string[];
  /** Start inline renaming (explorer); falls back to a prompt dialog when absent or it returns false. */
  startRename?: (id: string) => boolean | void;
  /** Called after items were trashed/moved away (e.g. to clear selection). */
  onRemoved?: () => void;
}

const SORT_LABELS: Record<SortKey, string> = { name: "Name", modified: "Date modified", type: "Type", pages: "Pages" };

export function useNodeActions({ folderId, siblingNames = [], startRename, onRemoved }: Options) {
  const navigate = useNavigate();
  const { data: me } = useMe();
  const { data: pins = [] } = usePins();
  const pinnedIds = new Set(pins.map((p) => p.id));
  const clipboard = useClipboard();
  const [moveTargets, setMoveTargets] = useState<LibraryNode[] | null>(null);
  const [propsNode, setPropsNode] = useState<LibraryNode | null>(null);
  const [choosingNotebook, setChoosingNotebook] = useState(false);
  const [tagTarget, setTagTarget] = useState<TagTarget | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef<string | null>(null);
  const trashing = useRef(new Set<string>());

  const open = (node: LibraryNode) => {
    if (node.kind === "folder") navigate(`/f/${node.id}`);
    else if (node.kind === "notebook") navigate(`/n/${node.id}`);
    else if (!node.available) toast("This bookmark's notebook is in the Trash. Restore it to read this bookmark.");
    else if (!node.page_count) navigate(`/b/${node.id}/edit`);
    else navigate(`/read/b/${node.id}`);
  };

  const read = (node: LibraryNode) => {
    if (node.kind === "notebook") navigate(`/read/n/${node.id}`);
    if (node.kind === "bookmark") navigate(`/read/b/${node.id}`);
  };

  const rename = async (node: LibraryNode) => {
    if (startRename && startRename(node.id) !== false) return;
    const name = await promptDialog({ title: "Rename", label: "Name", initial: node.name, confirmLabel: "Rename" });
    if (!name || name === node.name) return;
    try {
      await renameNode(node.id, name);
    } catch (err) {
      toastError(err);
    }
  };

  const trash = async (targets: LibraryNode[]) => {
    // A held Delete key or a double-click must not trash the same items twice.
    if (!targets.length || targets.some((t) => trashing.current.has(t.id))) return;
    const ids = targets.map((t) => t.id);
    for (const id of ids) trashing.current.add(id);
    try {
      if (!(await confirmTrash(targets))) return;
      await trashNodes(ids);
      onRemoved?.();
      toast(
        targets.length === 1 ? `“${targets[0].name}” moved to Trash.` : `${plural(targets.length, "item")} moved to Trash.`,
        { action: { label: "Undo", onClick: () => void restoreNodes(ids).catch(toastError) } },
      );
    } catch (err) {
      toastError(err);
    } finally {
      for (const id of ids) trashing.current.delete(id);
    }
  };

  const cut = (targets: LibraryNode[]) => {
    clipboard.set("cut", targets.map((t) => t.id));
    toast(`${plural(targets.length, "item")} cut. Paste into another folder to move.`);
  };

  const copy = (targets: LibraryNode[]) => {
    clipboard.set("copy", targets.map((t) => t.id));
    toast(`${plural(targets.length, "item")} copied.`);
  };

  const paste = async (target: string | null = folderId) => {
    const { mode, ids } = useClipboard.getState();
    if (!mode || !ids.length) return;
    const run = (list: string[]) => (mode === "cut" ? moveNodes(list, target) : copyNodes(list, target));
    let pasted = ids;
    try {
      try {
        await run(ids);
      } catch (err) {
        // Items trashed or deleted since they were cut or copied fail the whole paste: drop them and paste the rest.
        if (!(err instanceof ApiError && err.status === 404)) throw err;
        pasted = await liveNodeIds(ids);
        if (pasted.length === ids.length) throw err;
        if (!pasted.length) {
          useClipboard.getState().clear();
          toast("The items on the clipboard are in the Trash or were deleted.");
          return;
        }
        useClipboard.getState().set(mode, pasted);
        await run(pasted);
      }
      const gone = ids.length - pasted.length;
      const note = gone ? ` ${plural(gone, "item")} in the Trash or deleted ${gone === 1 ? "was" : "were"} skipped.` : "";
      if (mode === "cut") {
        useClipboard.getState().clear();
        toast(`Moved ${plural(pasted.length, "item")}.${note}`);
      } else {
        toast(`Pasted ${plural(pasted.length, "item")}.${note}`);
      }
    } catch (err) {
      toastError(err);
    }
  };

  const duplicate = async (targets: LibraryNode[]) => {
    try {
      // Each copy goes next to its original; search results can come from several folders.
      for (const [parent, ids] of groupByParent(targets.map((t) => [t.id, t.parent_id] as const))) {
        await copyNodes(ids, parent);
      }
      toast(targets.length === 1 ? `Duplicated “${targets[0].name}”.` : `Duplicated ${plural(targets.length, "item")}.`);
    } catch (err) {
      toastError(err);
    }
  };

  const setColor = (targets: LibraryNode[], color: FolderColor | null) =>
    setFolderColor(
      targets.map((t) => t.id),
      color,
    ).catch(toastError);

  const newFolder = async (parent: string | null = folderId) => {
    try {
      const name = uniqueName("New folder", parent === folderId ? siblingNames : []);
      const node = await createFolder(parent, name);
      if (startRename && parent === folderId) startRename(node.id);
      return node;
    } catch (err) {
      toastError(err);
    }
  };

  const newNotebook = async (parent: string | null = folderId) => {
    const name = await promptDialog({
      title: "New notebook",
      label: "Name",
      initial: uniqueName("Untitled notebook", parent === folderId ? siblingNames : []),
      confirmLabel: "Create",
    });
    if (!name) return;
    try {
      const node = await createNotebook(parent, name);
      navigate(`/n/${node.id}/upload`);
    } catch (err) {
      toastError(err);
    }
  };

  const newBookmark = (notebook?: LibraryNode) => {
    if (notebook) navigate(`/b/new?notebook=${notebook.id}&parent=${notebook.parent_id ?? ""}`);
    else setChoosingNotebook(true);
  };

  const upload = (parent: string | null = folderId) => {
    uploadTarget.current = parent;
    fileInput.current?.click();
  };

  const download = (node: LibraryNode) => safeDownload(node).catch(toastError);

  /** Tags a bookmark's pages, in its notebook. Loads the bookmark first: the listing lacks its pages. */
  const tagBookmarkPages = async (node: LibraryNode) => {
    try {
      const bm = await api<BookmarkDetail>(`/bookmarks/${node.id}`);
      queryClient.setQueryData(["bookmark", bm.id], bm);
      if (!bm.available) toast("This bookmark's notebook is in the Trash. Restore it to tag its pages.");
      else if (!bm.pages.length) toast("This bookmark has no pages.");
      else {
        setTagTarget({
          notebookId: bm.notebook.id,
          pages: bm.pages,
          description: `The pages of the bookmark “${bm.name}”: ${bm.label} of “${bm.notebook.name}”.`,
        });
      }
    } catch (err) {
      toastError(err);
    }
  };

  const pinEntry = (folders: LibraryNode[]): MenuEntry => {
    const ids = folders.map((f) => f.id);
    const allPinned = ids.every((id) => pinnedIds.has(id));
    return allPinned
      ? {
          label: "Unpin from sidebar",
          icon: <PinOff />,
          onSelect: () => void unpinFolders(ids).catch(toastError),
        }
      : {
          label: "Pin to sidebar",
          icon: <Pin />,
          onSelect: () => void pinFolders(ids.filter((id) => !pinnedIds.has(id))).catch(toastError),
        };
  };

  const setView = (view: Prefs["view"]) => updatePrefs({ view }).catch(toastError);
  const setSort = (sort: Partial<Prefs["sort"]>) => updatePrefs({ sort }).catch(toastError);

  function itemEntries(targets: LibraryNode[]): MenuEntry[] {
    if (!targets.length) return [];
    const single = targets.length === 1 ? targets[0] : null;
    const allFolders = targets.every((t) => t.kind === "folder");
    const entries: MenuEntry[] = [];
    if (allFolders) entries.push(pinEntry(targets));
    if (single?.kind === "folder") {
      entries.unshift({ label: "Open", icon: <FolderOpen />, onSelect: () => open(single) });
      if (clipboard.mode)
        entries.push({ label: "Paste into folder", icon: <ClipboardPaste />, onSelect: () => void paste(single.id) });
    }
    if (single?.kind === "notebook") {
      const empty = !single.page_count;
      entries.push(
        { label: "Open", icon: <NotebookPen />, onSelect: () => open(single) },
        { label: "Read", icon: <BookOpen />, onSelect: () => read(single), disabled: empty },
        { label: "Add PDF…", icon: <FilePlus2 />, onSelect: () => navigate(`/n/${single.id}/upload`) },
        { label: "New bookmark…", icon: <BookmarkPlus />, onSelect: () => newBookmark(single), disabled: empty },
        { label: "Download PDF", icon: <Download />, onSelect: () => void download(single), disabled: empty },
      );
    }
    if (single?.kind === "bookmark") {
      const usable = !!single.available;
      entries.push(
        { label: "Read", icon: <BookOpen />, onSelect: () => read(single), disabled: !usable || !single.page_count },
        { label: "Edit pages", icon: <Pencil />, onSelect: () => navigate(`/b/${single.id}/edit`), disabled: !usable },
        {
          label: "Tag pages…",
          icon: <Tag />,
          onSelect: () => void tagBookmarkPages(single),
          disabled: !usable || !single.page_count,
        },
        {
          label: "Open notebook",
          icon: <NotebookPen />,
          onSelect: () => navigate(`/n/${single.notebook_id}`),
          disabled: !usable,
        },
        {
          label: "Download PDF",
          icon: <Download />,
          onSelect: () => void download(single),
          disabled: !usable || !single.page_count,
        },
      );
    }
    entries.push(
      { type: "sep" },
      { label: "Cut", icon: <Scissors />, shortcut: "Ctrl+X", onSelect: () => cut(targets) },
      { label: "Copy", icon: <Copy />, shortcut: "Ctrl+C", onSelect: () => copy(targets) },
      { label: "Duplicate", icon: <CopyPlus />, onSelect: () => void duplicate(targets) },
      { type: "sep" },
    );
    if (single) entries.push({ label: "Rename", icon: <Pencil />, shortcut: "F2", onSelect: () => void rename(single) });
    if (allFolders) {
      const colors = new Set(targets.map((t) => t.color ?? null));
      entries.push({
        type: "sub",
        label: "Color",
        icon: <Palette />,
        items: [
          {
            type: "colors",
            value: colors.size === 1 ? [...colors][0] : "mixed",
            onSelect: (c) => void setColor(targets, c),
          },
        ],
      });
    }
    entries.push(
      { label: "Move to…", icon: <FolderInput />, onSelect: () => setMoveTargets(targets) },
      { type: "sep" },
      { label: "Delete", icon: <Trash2 />, shortcut: "Del", danger: true, onSelect: () => void trash(targets) },
    );
    if (single) entries.push({ type: "sep" }, { label: "Properties", icon: <Info />, onSelect: () => setPropsNode(single) });
    return entries;
  }

  function backgroundEntries(extra: { selectAll?: () => void; folder?: LibraryNode | null } = {}): MenuEntry[] {
    const view = me?.prefs.view ?? "grid";
    const sort = me?.prefs.sort ?? { key: "name", dir: "asc" };
    return [
      { label: "New folder", icon: <FolderPlus />, onSelect: () => void newFolder() },
      { label: "New notebook", icon: <NotebookPen />, onSelect: () => void newNotebook() },
      { label: "New bookmark…", icon: <BookmarkPlus />, onSelect: () => newBookmark() },
      { label: "Upload PDFs…", icon: <Upload />, onSelect: () => upload() },
      { type: "sep" },
      {
        label: clipboard.mode ? `Paste ${plural(clipboard.ids.length, "item")}` : "Paste",
        icon: <ClipboardPaste />,
        shortcut: "Ctrl+V",
        disabled: !clipboard.mode,
        onSelect: () => void paste(),
      },
      { type: "sep" },
      {
        type: "sub",
        label: "View",
        icon: view === "grid" ? <LayoutGrid /> : <List />,
        items: [
          { label: "Grid", checked: view === "grid", onSelect: () => void setView("grid") },
          { label: "List", checked: view === "list", onSelect: () => void setView("list") },
        ],
      },
      {
        type: "sub",
        label: "Sort by",
        icon: <ArrowDownAZ />,
        items: [
          ...(Object.keys(SORT_LABELS) as SortKey[]).map((key) => ({
            label: SORT_LABELS[key],
            checked: sort.key === key,
            onSelect: () => void setSort({ key }),
          })),
          { type: "sep" as const },
          { label: "Ascending", checked: sort.dir === "asc", onSelect: () => void setSort({ dir: "asc" }) },
          { label: "Descending", checked: sort.dir === "desc", onSelect: () => void setSort({ dir: "desc" }) },
        ],
      },
      ...(extra.selectAll
        ? [{ type: "sep" as const }, { label: "Select all", icon: <MousePointerSquareDashed />, shortcut: "Ctrl+A", onSelect: extra.selectAll }]
        : []),
      ...(extra.folder ? [{ type: "sep" as const }, pinEntry([extra.folder])] : []),
      ...(extra.folder
        ? [{ label: "Folder properties", icon: <Info />, onSelect: () => setPropsNode(extra.folder!) }]
        : []),
    ];
  }

  function searchEntries(node: LibraryNode): MenuEntry[] {
    return [
      {
        label: "Open file location",
        icon: <FileSearch />,
        onSelect: () => navigate(node.parent_id ? `/f/${node.parent_id}` : "/"),
      },
      { type: "sep" },
      ...itemEntries([node]),
    ];
  }

  const dialogs = (
    <>
      <MoveDialog
        targets={moveTargets}
        onClose={() => setMoveTargets(null)}
        onMove={async (dest) => {
          const origins = new Map((moveTargets ?? []).map((t) => [t.id, t.parent_id]));
          const ids = [...origins.keys()];
          await moveNodes(ids, dest);
          onRemoved?.();
          toast(`Moved ${plural(ids.length, "item")}.`, {
            action: { label: "Undo", onClick: () => void moveBack(origins).catch(toastError) },
          });
        }}
      />
      <PropertiesDialog node={propsNode} onClose={() => setPropsNode(null)} />
      <TagPagesDialog target={tagTarget} onClose={() => setTagTarget(null)} />
      <ChooseNotebookDialog
        open={choosingNotebook}
        onClose={() => setChoosingNotebook(false)}
        onChoose={(nb) => {
          setChoosingNotebook(false);
          navigate(`/b/new?notebook=${nb.id}&parent=${folderId ?? ""}`);
        }}
      />
      <input
        ref={fileInput}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length) void uploadAsNotebooks(files, uploadTarget.current);
        }}
      />
    </>
  );

  return {
    open,
    read,
    rename,
    trash,
    cut,
    copy,
    paste,
    duplicate,
    newFolder,
    newNotebook,
    newBookmark,
    upload,
    download,
    setView,
    setSort,
    showProperties: setPropsNode,
    moveTo: setMoveTargets,
    itemEntries,
    backgroundEntries,
    searchEntries,
    dialogs,
  };
}

export type NodeActions = ReturnType<typeof useNodeActions>;
