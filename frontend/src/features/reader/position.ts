import type { PageRef, Progress } from "../../api/types";

/**
 * The page (1-based) the reader opens at: the `?page=` it was opened with, else the saved
 * position. A saved page that was deleted since gives way to the page now at its place.
 * pdf.js takes whole page numbers only.
 */
export function startPage(
  query: string | null,
  pages: Pick<PageRef, "id">[],
  saved?: Pick<Progress, "page_id" | "page_index"> | null,
): number {
  const total = pages.length;
  const fromQuery = Math.floor(Number(query));
  if (fromQuery >= 1) return Math.min(fromQuery, total);
  if (!saved) return 1;
  const index = saved.page_id ? pages.findIndex((p) => p.id === saved.page_id) : -1;
  if (index >= 0) return index + 1;
  return Math.max(1, Math.min(Math.floor(saved.page_index) + 1, total));
}
