/** Drag-and-drop of library items between folders (HTML5 DnD). */

export const NODE_MIME = "application/x-academia-nodes";

let dragging: { ids: string[]; folderIds: Set<string>; fromFolder: string | null } | null = null;

export function startNodeDrag(
  e: React.DragEvent,
  ids: string[],
  folderIds: string[],
  fromFolder: string | null,
  label: string,
): void {
  dragging = { ids, folderIds: new Set(folderIds), fromFolder };
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
  if (!dragging) return false;
  if (folderId && dragging.folderIds.has(folderId)) return false;
  return true;
}

export function dropEffect(e: React.DragEvent): "copy" | "move" {
  return e.ctrlKey || e.altKey || e.metaKey ? "copy" : "move";
}
