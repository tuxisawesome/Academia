import type { TagChanges } from "../../api/actions";
import type { PageRef } from "../../api/types";

/** The tags a set of pages has between them. */
export interface PageTagState {
  /** The date every page has (null: none of them has one), or "mixed" when they differ. */
  date: string | null | "mixed";
  /** Classes every page has. */
  all: string[];
  /** Classes some of the pages have, but not all. */
  some: string[];
}

export function tagState(pages: Pick<PageRef, "date" | "class_ids">[]): PageTagState {
  const dates = new Set(pages.map((p) => p.date ?? null));
  const counts = new Map<string, number>();
  for (const page of pages) {
    for (const id of new Set(page.class_ids)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const ids = [...counts.keys()];
  return {
    date: dates.size > 1 ? "mixed" : ([...dates][0] ?? null),
    all: ids.filter((id) => counts.get(id) === pages.length),
    some: ids.filter((id) => counts.get(id)! < pages.length),
  };
}

/** What the tag dialog shows once the user has made changes. */
export interface TagEdits {
  /** The date to give every page (null: clear it); undefined while it is left as it was. */
  date: string | null | undefined;
  /** Classes to have on every page. */
  all: string[];
  /** Classes left on the pages that have them. */
  some: string[];
}

/** The request that turns `initial` into `edits`, or null when nothing changed. */
export function tagChanges(initial: PageTagState, edits: TagEdits): TagChanges | null {
  const changes: TagChanges = {};
  if (edits.date !== undefined && edits.date !== initial.date) changes.date = edits.date;
  const add = edits.all.filter((id) => !initial.all.includes(id));
  const kept = new Set([...edits.all, ...edits.some]);
  const remove = [...initial.all, ...initial.some].filter((id) => !kept.has(id));
  if (add.length) changes.addClasses = add;
  if (remove.length) changes.removeClasses = remove;
  return Object.keys(changes).length ? changes : null;
}
