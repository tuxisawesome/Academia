import { groupByParent } from "../lib/parents";
import { api, ApiError, downloadUrl } from "./client";
import { invalidateLibrary, queryClient } from "./queries";
import type {
  BookmarkDetail,
  FolderColor,
  LibraryNode,
  NotebookDetail,
  PinnedFolder,
  Prefs,
  PrefsPatch,
  User,
} from "./types";

// ---- library ------------------------------------------------------------------------

export async function createFolder(parentId: string | null, name: string, color?: FolderColor | null) {
  const node = await api<LibraryNode>("/folders", { method: "POST", json: { parent_id: parentId, name, color } });
  await invalidateLibrary();
  return node;
}

export async function createNotebook(parentId: string | null, name: string, sourceId?: string) {
  const node = await api<LibraryNode>("/notebooks", {
    method: "POST",
    json: { parent_id: parentId, name, source_id: sourceId ?? null },
  });
  await invalidateLibrary();
  return node;
}

export async function createBookmark(parentId: string | null, name: string, notebookId: string, pageIds: string[]) {
  const node = await bookmarkEdit(null, () =>
    api<LibraryNode>("/bookmarks", {
      method: "POST",
      json: { parent_id: parentId, name, notebook_id: notebookId, page_ids: pageIds },
    }),
  );
  await invalidateLibrary();
  return node;
}

export async function renameNode(id: string, name: string) {
  const node = await api<LibraryNode>(`/nodes/${id}`, { method: "PATCH", json: { name } });
  await invalidateLibrary();
  return node;
}

export async function setFolderColor(ids: string[], color: FolderColor | null) {
  const results = await Promise.allSettled(
    ids.map((id) =>
      api(`/nodes/${id}`, { method: "PATCH", json: color ? { color } : { clear_color: true } }),
    ),
  );
  // Refresh even if some failed: the others are already saved.
  await invalidateLibrary();
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
}

export async function moveNodes(ids: string[], targetId: string | null) {
  const res = await api<{ moved: number }>("/nodes/move", { method: "POST", json: { ids, target_id: targetId } });
  await invalidateLibrary();
  return res.moved;
}

/** Undoes a move: puts every item back into the folder it came from (id → original parent). */
export async function moveBack(origins: Map<string, string | null>) {
  try {
    for (const [parent, ids] of groupByParent(origins)) {
      await api("/nodes/move", { method: "POST", json: { ids, target_id: parent } });
    }
  } finally {
    await invalidateLibrary();
  }
}

export async function copyNodes(ids: string[], targetId: string | null) {
  const res = await api<{ ids: string[] }>("/nodes/copy", { method: "POST", json: { ids, target_id: targetId } });
  await invalidateLibrary();
  return res.ids;
}

/** The ids that still name live items; ones trashed or deleted since (e.g. on the clipboard) are left out. */
export async function liveNodeIds(ids: string[]): Promise<string[]> {
  const live = await Promise.all(
    ids.map((id) =>
      api<LibraryNode>(`/nodes/${id}`).then(
        (node) => !node.trashed_at,
        (err) => {
          if (err instanceof ApiError && err.status === 404) return false;
          throw err;
        },
      ),
    ),
  );
  return ids.filter((_, i) => live[i]);
}

export async function trashCheck(ids: string[]) {
  return api<{ bookmarks_elsewhere: number }>("/nodes/trash-check", { method: "POST", json: { ids } });
}

export async function trashNodes(ids: string[]) {
  const res = await api<{ trashed: number }>("/nodes/trash", { method: "POST", json: { ids } });
  await invalidateLibrary();
  return res.trashed;
}

export async function restoreNodes(ids: string[]) {
  await api("/trash/restore", { method: "POST", json: { ids } });
  await invalidateLibrary();
}

export async function purgeNodes(ids: string[]) {
  await api("/trash/purge", { method: "POST", json: { ids } });
  await invalidateLibrary();
}

export async function emptyTrash() {
  await api("/trash/empty", { method: "POST" });
  await invalidateLibrary();
}

// ---- sidebar pins ----------------------------------------------------------------------

/** Sends one pin request per folder; if one fails, reloads the pins the earlier ones changed. */
async function eachPin(ids: string[], request: (id: string) => Promise<PinnedFolder[]>) {
  let pins: PinnedFolder[] = [];
  try {
    for (const id of ids) pins = await request(id);
  } catch (err) {
    void queryClient.invalidateQueries({ queryKey: ["pins"] });
    throw err;
  }
  queryClient.setQueryData(["pins"], pins);
  return pins;
}

export function pinFolders(ids: string[]) {
  return eachPin(ids, (id) => api<PinnedFolder[]>("/pins", { method: "POST", json: { node_id: id } }));
}

export function unpinFolders(ids: string[]) {
  return eachPin(ids, (id) => api<PinnedFolder[]>(`/pins/${id}`, { method: "DELETE" }));
}

export async function reorderPins(ids: string[]) {
  const previous = queryClient.getQueryData<PinnedFolder[]>(["pins"]);
  if (previous) {
    queryClient.setQueryData(
      ["pins"],
      ids.map((id) => previous.find((p) => p.id === id)).filter((p): p is PinnedFolder => !!p),
    );
  }
  try {
    const pins = await api<PinnedFolder[]>("/pins/order", { method: "PUT", json: { node_ids: ids } });
    queryClient.setQueryData(["pins"], pins);
    return pins;
  } catch (err) {
    void queryClient.invalidateQueries({ queryKey: ["pins"] });
    throw err;
  }
}

// ---- notebooks -----------------------------------------------------------------------

function storeNotebook(detail: NotebookDetail): NotebookDetail {
  queryClient.setQueryData(["notebook", detail.id], detail);
  void invalidateLibrary();
  return detail;
}

// Edits of a notebook are sent one at a time, so a quick second edit (pressing `]` twice, two
// drags in a row) waits for the first one instead of racing it with the same rev.
const pendingEdits = new Map<string, Promise<unknown>>();
// Per notebook: the rev each of this client's own edits started from -> the rev it produced.
const ownEdits = new Map<string, Map<number, number>>();

/** `rev` moved past the edits this client has made to the notebook since. */
function afterOwnEdits(id: string, rev: number): number {
  const steps = ownEdits.get(id);
  while (steps?.has(rev)) rev = steps.get(rev)!;
  return rev;
}

/**
 * Runs a notebook edit once earlier edits of the same notebook are done. `run` sends the edit
 * with the rev it is given: `baseRev` (the rev the user's view showed; null = unchecked) moved
 * past the edits this client has made since, so only changes made elsewhere conflict. The
 * result is shown once no later edit of the notebook is waiting. If the edit fails, reloads the
 * notebook (it may have been shown optimistically) and rethrows; on a stale-revision conflict
 * the reload finishes first.
 */
function notebookEdit(
  id: string,
  baseRev: number | null,
  run: (rev: number | null) => Promise<NotebookDetail>,
): Promise<NotebookDetail> {
  const edit = (pendingEdits.get(id) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const rev = baseRev === null ? null : afterOwnEdits(id, baseRev);
      // An edit that sends no rev (undo) is taken to start from the rev this client last saw,
      // which includes its own edits not shown yet.
      const shown = queryClient.getQueryData<NotebookDetail>(["notebook", id])?.rev;
      const from = rev ?? (shown === undefined ? undefined : afterOwnEdits(id, shown));
      try {
        const detail = await run(rev);
        // One step up means nothing else changed the notebook in between.
        if (from !== undefined && detail.rev === from + 1) {
          if (!ownEdits.has(id)) ownEdits.set(id, new Map());
          ownEdits.get(id)!.set(from, detail.rev);
        }
        // A later edit is waiting: this result lacks it, and showing it would undo a drag already
        // shown (until that edit is saved) and have the next drag made from the old order.
        if (pendingEdits.get(id) !== edit) return detail;
        return storeNotebook(detail);
      } catch (err) {
        // The library too: the edits this one waited for were saved without their results shown.
        const reload = invalidateLibrary();
        if (err instanceof ApiError && err.status === 409) await reload;
        throw err;
      }
    });
  pendingEdits.set(id, edit);
  const settled = () => {
    if (pendingEdits.get(id) === edit) pendingEdits.delete(id);
  };
  edit.then(settled, settled);
  return edit;
}

export function insertSource(
  nb: NotebookDetail,
  sourceId: string,
  position: { at: "start" | "end" } | { at: "after"; afterPageId: string },
  addToBookmarks: string[] = [],
  baseRev: number | null = nb.rev,
) {
  return notebookEdit(nb.id, baseRev, (rev) =>
    api<NotebookDetail>(`/notebooks/${nb.id}/pages/insert`, {
      method: "POST",
      json: {
        base_rev: rev,
        source_id: sourceId,
        at: position.at,
        after_page_id: position.at === "after" ? position.afterPageId : null,
        add_to_bookmarks: addToBookmarks,
      },
    }),
  );
}

export function reorderPages(nb: NotebookDetail, pageIds: string[]) {
  // A reload already on its way would bring back the order from before this one.
  void queryClient.cancelQueries({ queryKey: ["notebook", nb.id] });
  queryClient.setQueryData<NotebookDetail>(["notebook", nb.id], (old) =>
    old ? { ...old, pages: pageIds.map((id) => old.pages.find((p) => p.id === id)!).filter(Boolean) } : old,
  );
  return notebookEdit(nb.id, nb.rev, (rev) =>
    api<NotebookDetail>(`/notebooks/${nb.id}/pages/order`, {
      method: "PUT",
      json: { base_rev: rev, page_ids: pageIds },
    }),
  );
}

export function rotatePages(nb: NotebookDetail, pageIds: string[], delta: 90 | -90 | 180) {
  return notebookEdit(nb.id, nb.rev, (rev) =>
    api<NotebookDetail>(`/notebooks/${nb.id}/pages/rotate`, {
      method: "POST",
      json: { base_rev: rev, page_ids: pageIds, delta },
    }),
  );
}

export function deletePages(nb: NotebookDetail, pageIds: string[]) {
  return notebookEdit(nb.id, nb.rev, (rev) =>
    api<NotebookDetail>(`/notebooks/${nb.id}/pages/delete`, {
      method: "POST",
      json: { base_rev: rev, page_ids: pageIds },
    }),
  );
}

export function undeletePages(notebookId: string, batch: string) {
  return notebookEdit(notebookId, null, () =>
    api<NotebookDetail>(`/notebooks/${notebookId}/pages/undelete`, { method: "POST", json: { batch } }),
  );
}

// ---- bookmarks -----------------------------------------------------------------------

/**
 * Runs a bookmark change. On a conflict (pages deleted, or the bookmark changed somewhere
 * else), reloads the notebook and bookmark on screen so the user can review them, and rethrows.
 */
async function bookmarkEdit<T>(bookmarkId: string | null, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["notebook"] }),
        bookmarkId ? queryClient.invalidateQueries({ queryKey: ["bookmark", bookmarkId] }) : undefined,
      ]);
    }
    throw err;
  }
}

/** Replaces a bookmark's pages. With `baseRev`, fails with 409 if it was changed elsewhere since. */
export async function setBookmarkPages(id: string, pageIds: string[], baseRev: number | null = null) {
  const detail = await bookmarkEdit(id, () =>
    api<BookmarkDetail>(`/bookmarks/${id}/pages`, { method: "PUT", json: { page_ids: pageIds, base_rev: baseRev } }),
  );
  queryClient.setQueryData(["bookmark", id], detail);
  await invalidateLibrary();
  return detail;
}

export async function addPagesToBookmark(id: string, pageIds: string[]) {
  const detail = await bookmarkEdit(id, () =>
    api<BookmarkDetail>(`/bookmarks/${id}/pages/add`, {
      method: "POST",
      json: { page_ids: pageIds },
    }),
  );
  await invalidateLibrary();
  return detail;
}

// ---- downloads -------------------------------------------------------------------------

export function downloadNode(node: Pick<LibraryNode, "id" | "kind">) {
  if (node.kind === "notebook") downloadUrl(`/api/notebooks/${node.id}/pdf?variant=download`);
  else if (node.kind === "bookmark") downloadUrl(`/api/bookmarks/${node.id}/pdf?variant=download`);
}

/** Checks the PDF can be produced (e.g. it has pages) before starting a browser download. */
export async function safeDownload(node: Pick<LibraryNode, "id" | "kind" | "page_count">) {
  if (!node.page_count) {
    throw new ApiError(409, "empty", node.kind === "bookmark" ? "This bookmark has no pages." : "This notebook has no pages yet.");
  }
  downloadNode(node);
}

// ---- account ----------------------------------------------------------------------------

/** Applies a preferences patch the way the server does: `sort` and `reader` field by field. */
export function mergePrefs(prefs: Prefs, patch: PrefsPatch): Prefs {
  return {
    ...prefs,
    ...patch,
    reader: { ...prefs.reader, ...patch.reader },
    sort: { ...prefs.sort, ...patch.sort },
  };
}

/**
 * Saves preferences. Send only the fields that changed: the server merges them into what it has,
 * so a tab with an older copy of the preferences doesn't undo a change made in another tab.
 */
export async function updatePrefs(patch: PrefsPatch) {
  const current = queryClient.getQueryData<User | null>(["me"]);
  if (current) queryClient.setQueryData<User>(["me"], { ...current, prefs: mergePrefs(current.prefs, patch) });
  try {
    const user = await api<User>("/me/prefs", { method: "PATCH", json: patch });
    queryClient.setQueryData(["me"], user);
  } catch (err) {
    // Reload rather than restore a snapshot, which may hold another change's optimistic value.
    void queryClient.invalidateQueries({ queryKey: ["me"] });
    throw err;
  }
}

/**
 * Signs out. If the server can't be reached the session is still valid, so the tab stays signed
 * in and the error is thrown; clearing the signed-in user drops every cache (see queries.ts).
 */
export async function logout() {
  await api("/auth/logout", { method: "POST" });
  queryClient.setQueryData(["me"], null);
}
