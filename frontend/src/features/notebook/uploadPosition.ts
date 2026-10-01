/**
 * The page number typed into the "After page" field: rounded and clamped to 1..pageCount.
 * The field keeps the raw text so it can be cleared while typing; until it holds a number, page 1 is used.
 */
export function afterPageNumber(raw: string, pageCount: number): number {
  const n = Math.round(Number(raw));
  if (!raw.trim() || !Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(pageCount, n));
}

/** The checked bookmarks that are still listed for the current insertion point. */
export function listedBookmarkIds(checked: Iterable<string>, listed: { bookmark: { id: string } }[]): string[] {
  const ids = new Set(listed.map((x) => x.bookmark.id));
  return [...checked].filter((id) => ids.has(id));
}
