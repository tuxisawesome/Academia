/** Drag-and-drop of library items between folders (HTML5 DnD). */

import { queryClient } from "../api/queries";
import type { TreeFolder } from "../api/types";

export const NODE_MIME = "application/x-academia-nodes";

let dragging: {
  ids: string[];
  folderIds: Set<string>;
  /** The dragged folders and every folder inside them: a folder can't be moved into itself. */
  blocked: Set<string>;
  /** The folder each dragged id is in (search results can come from many). */
  origins: Map<string, string | null>;
} | null = null;

/** `ids` plus all folders below them in `folders`. */
export function withDescendants(ids: Iterable<string>, folders: TreeFolder[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const f of folders) {
    if (f.parent_id) children.set(f.parent_id, [...(children.get(f.parent_id) ?? []), f.id]);
  }
  const out = new Set<string>();
  const walk = (id: string) => {
    if (out.has(id)) return;
    out.add(id);
    children.get(id)?.forEach(walk);
  };
  for (const id of ids) walk(id);
  return out;
}

export function startNodeDrag(
  e: React.DragEvent,
  ids: string[],
  folderIds: string[],
  origins: Map<string, string | null>,
  label: string,
): void {
  const tree = queryClient.getQueryData<TreeFolder[]>(["tree"]) ?? [];
  dragging = { ids, folderIds: new Set(folderIds), blocked: withDescendants(folderIds, tree), origins };
  // Folders move/copy items ("move"/"copy"); the sidebar's Pinned section links them ("link").
  // A drop whose effect isn't allowed here is silently cancelled by the browser.
  e.dataTransfer.effectAllowed = "all";
  e.dataTransfer.setData(NODE_MIME, JSON.stringify(ids));
  e.dataTransfer.setData("text/plain", label);
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost";
  ghost.textContent = label;
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, 16, 16);
  setTimeout(() => ghost.remove(), 0);
}

export function endNodeDrag(): void {
  dragging = null;
}

export function currentDrag() {
  return dragging;
}

export function isNodeDrag(e: React.DragEvent | DragEvent): boolean {
  return !!e.dataTransfer?.types.includes(NODE_MIME);
}

export function isFileDrag(e: React.DragEvent | DragEvent): boolean {
  return !!e.dataTransfer?.types.includes("Files") && !isNodeDrag(e);
}

/** Whether the dragged items may be dropped into `folderId` (null = library root). */
export function canDropInto(folderId: string | null): boolean {
  const drag = dragging;
  if (!drag) return false;
  if (folderId && drag.blocked.has(folderId)) return false;
  // Nothing to do where every dragged item already is.
  return drag.ids.some((id) => drag.origins.get(id) !== folderId);
}

export function dropEffect(e: React.DragEvent): "copy" | "move" {
  return e.ctrlKey || e.altKey || e.metaKey ? "copy" : "move";
}

/**
 * Stops the browser from opening a file dropped outside the app's drop zones, which would leave the
 * app and abort running uploads. Drop zones handle the drag first and cancel it themselves.
 */
export function guardFileDrops(): void {
  window.addEventListener("dragover", (e) => {
    if (e.defaultPrevented || !e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "none";
  });
  window.addEventListener("drop", (e) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  });
}
