import type { FolderColor } from "../api/types";

export const FOLDER_COLORS: { key: FolderColor; label: string }[] = [
  { key: "oxblood", label: "Oxblood" },
  { key: "terracotta", label: "Terracotta" },
  { key: "ochre", label: "Ochre" },
  { key: "olive", label: "Olive" },
  { key: "forest", label: "Forest" },
  { key: "teal", label: "Teal" },
  { key: "slate", label: "Slate" },
  { key: "navy", label: "Navy" },
  { key: "plum", label: "Plum" },
  { key: "graphite", label: "Graphite" },
];

export function folderColorVar(color: FolderColor | null | undefined): string {
  return color ? `var(--fc-${color})` : "var(--folder-default)";
}

/** Stable marker color for a bookmark (used for ribbons on page thumbnails). */
export function bookmarkColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return folderColorVar(FOLDER_COLORS[h % FOLDER_COLORS.length].key);
}
