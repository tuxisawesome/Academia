import type { LibraryNode, Prefs } from "../../api/types";
import { compareNames } from "../../lib/format";

const KIND_ORDER = { folder: 0, notebook: 1, bookmark: 2 } as const;

/** Folders always come first; everything else follows the chosen key and direction. */
export function sortNodes(items: LibraryNode[], sort: Prefs["sort"]): LibraryNode[] {
  const dir = sort.dir === "desc" ? -1 : 1;
  return [...items].sort((a, b) => {
    const af = a.kind === "folder";
    const bf = b.kind === "folder";
    if (af !== bf) return af ? -1 : 1;
    let c = 0;
    switch (sort.key) {
      case "modified":
        c = a.updated_at.localeCompare(b.updated_at);
        break;
      case "type":
        c = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
        break;
      case "pages":
        c = (a.page_count ?? a.child_count ?? 0) - (b.page_count ?? b.child_count ?? 0);
        break;
    }
    if (c === 0) c = compareNames(a.name, b.name);
    return c * dir;
  });
}
