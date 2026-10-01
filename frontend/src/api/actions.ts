import { api, ApiError, downloadUrl } from "./client";
import { invalidateLibrary, queryClient } from "./queries";
import type { BookmarkDetail, FolderColor, LibraryNode, NotebookDetail, PinnedFolder, Prefs, User } from "./types";

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
  const node = await api<LibraryNode>("/bookmarks", {
    method: "POST",
    json: { parent_id: parentId, name, notebook_id: notebookId, page_ids: pageIds },
  });
  await invalidateLibrary();
  return node;
}

export async function renameNode(id: string, name: string) {
  const node = await api<LibraryNode>(`/nodes/${id}`, { method: "PATCH", json: { name } });
  await invalidateLibrary();
  return node;
}

export async function setFolderColor(ids: string[], color: FolderColor | null) {
  await Promise.all(
    ids.map((id) =>
      api(`/nodes/${id}`, { method: "PATCH", json: color ? { color } : { clear_color: true } }),
    ),
  );
  await invalidateLibrary();
}

export async function moveNodes(ids: string[], targetId: string | null) {
  const res = await api<{ moved: number }>("/nodes/move", { method: "POST", json: { ids, target_id: targetId } });
  await invalidateLibrary();
  return res.moved;
}

export async function copyNodes(ids: string[], targetId: string | null) {
  const res = await api<{ ids: string[] }>("/nodes/copy", { method: "POST", json: { ids, target_id: targetId } });
  await invalidateLibrary();
  return res.ids;
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

export async function pinFolders(ids: string[]) {
  let pins: PinnedFolder[] = [];
  for (const id of ids) pins = await api<PinnedFolder[]>("/pins", { method: "POST", json: { node_id: id } });
  queryClient.setQueryData(["pins"], pins);
  return pins;
}

export async function unpinFolders(ids: string[]) {
  let pins: PinnedFolder[] = [];
  for (const id of ids) pins = await api<PinnedFolder[]>(`/pins/${id}`, { method: "DELETE" });
  queryClient.setQueryData(["pins"], pins);
  return pins;
}

export async function reorderPins(ids: string[]) {
  const previous = queryClient.getQueryData<PinnedFolder[]>(["pins"]);
  if (previous) {
    queryClient.setQueryData(
      ["pins"],
      ids.map((id) => previous.find((p) => p.id === id)).filter((p): p is PinnedFolder => !!p),
    );
  }
  const pins = await api<PinnedFolder[]>("/pins/order", { method: "PUT", json: { node_ids: ids } });
  queryClient.setQueryData(["pins"], pins);
  return pins;
}

// ---- notebooks -----------------------------------------------------------------------

function storeNotebook(detail: NotebookDetail): NotebookDetail {
  queryClient.setQueryData(["notebook", detail.id], detail);
  void invalidateLibrary();
  return detail;
}

/** Runs a notebook edit; on a stale-revision conflict, reloads the notebook and rethrows. */
async function notebookEdit(id: string, run: () => Promise<NotebookDetail>): Promise<NotebookDetail> {
  try {
    return storeNotebook(await run());
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      await queryClient.invalidateQueries({ queryKey: ["notebook", id] });
    }
    throw err;
  }
}

export function insertSource(
  nb: NotebookDetail,
  sourceId: string,
  position: { at: "start" | "end" } | { at: "after"; afterPageId: string },
  addToBookmarks: string[] = [],
  baseRev: number | null = nb.rev,
) {
  return notebookEdit(nb.id, () =>
    api<NotebookDetail>(`/notebooks/${nb.id}/pages/insert`, {
      method: "POST",
      json: {
        base_rev: baseRev,
        source_id: sourceId,
        at: position.at,
        after_page_id: position.at === "after" ? position.afterPageId : null,
        add_to_bookmarks: addToBookmarks,
      },
    }),
  );
}

export function reorderPages(nb: NotebookDetail, pageIds: string[]) {
  queryClient.setQueryData<NotebookDetail>(["notebook", nb.id], (old) =>
    old ? { ...old, pages: pageIds.map((id) => old.pages.find((p) => p.id === id)!).filter(Boolean) } : old,
  );
  return notebookEdit(nb.id, () =>
    api<NotebookDetail>(`/notebooks/${nb.id}/pages/order`, {
      method: "PUT",
      json: { base_rev: nb.rev, page_ids: pageIds },
    }),
  );
}

export function rotatePages(nb: NotebookDetail, pageIds: string[], delta: 90 | -90 | 180) {
  return notebookEdit(nb.id, () =>
    api<NotebookDetail>(`/notebooks/${nb.id}/pages/rotate`, {
      method: "POST",
      json: { base_rev: nb.rev, page_ids: pageIds, delta },
    }),
  );
}

export function deletePages(nb: NotebookDetail, pageIds: string[]) {
  return notebookEdit(nb.id, () =>
    api<NotebookDetail>(`/notebooks/${nb.id}/pages/delete`, {
      method: "POST",
      json: { base_rev: nb.rev, page_ids: pageIds },
    }),
  );
}

export function undeletePages(notebookId: string, batch: string) {
  return notebookEdit(notebookId, () =>
    api<NotebookDetail>(`/notebooks/${notebookId}/pages/undelete`, { method: "POST", json: { batch } }),
  );
}

// ---- bookmarks -----------------------------------------------------------------------

export async function setBookmarkPages(id: string, pageIds: string[]) {
  const detail = await api<BookmarkDetail>(`/bookmarks/${id}/pages`, { method: "PUT", json: { page_ids: pageIds } });
  queryClient.setQueryData(["bookmark", id], detail);
  await invalidateLibrary();
  return detail;
}

export async function addPagesToBookmark(id: string, pageIds: string[]) {
  const detail = await api<BookmarkDetail>(`/bookmarks/${id}/pages/add`, {
    method: "POST",
    json: { page_ids: pageIds },
  });
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

export async function updatePrefs(patch: Partial<Prefs>) {
  const previous = queryClient.getQueryData<User | null>(["me"]);
  if (previous) {
    queryClient.setQueryData<User>(["me"], {
      ...previous,
      prefs: {
        ...previous.prefs,
        ...patch,
        reader: { ...previous.prefs.reader, ...(patch.reader ?? {}) },
        sort: { ...previous.prefs.sort, ...(patch.sort ?? {}) },
      },
    });
  }
  try {
    const user = await api<User>("/me/prefs", { method: "PATCH", json: patch });
    queryClient.setQueryData(["me"], user);
  } catch (err) {
    if (previous) queryClient.setQueryData(["me"], previous);
    throw err;
  }
}

export async function logout() {
  const { stopRecognition } = await import("../features/recognition");
  stopRecognition();
  try {
    await api("/auth/logout", { method: "POST" });
  } finally {
    queryClient.clear();
    queryClient.setQueryData(["me"], null);
  }
}
