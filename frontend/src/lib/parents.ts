/**
 * Item ids grouped by the folder they are in (null = Library root), in first-seen order.
 * Search results can come from many folders, so a move's Undo or a Duplicate works per group.
 */
export function groupByParent(items: Iterable<readonly [id: string, parentId: string | null]>): [string | null, string[]][] {
  const groups = new Map<string | null, string[]>();
  for (const [id, parent] of items) {
    const ids = groups.get(parent);
    if (ids) ids.push(id);
    else groups.set(parent, [id]);
  }
  return [...groups];
}
