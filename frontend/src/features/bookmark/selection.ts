/**
 * Selection logic of the bookmark editor. Selections are sets of page ids.
 */

import { parseRanges } from "../../lib/ranges";

export interface RangeTextResult {
  selected: Set<string>;
  error: string | null;
}

/**
 * The selection for text typed into the page-range field. While the text is not a valid list of
 * ranges, `beforeTyping` (the selection from before the user started typing) is kept rather than
 * the pages of whatever part of the text happened to parse.
 */
export function selectionForRangeText(
  text: string,
  pages: readonly { id: string }[],
  beforeTyping: Set<string>,
): RangeTextResult {
  const result = parseRanges(text, pages.length);
  if (result.error) return { selected: beforeTyping, error: result.error };
  return { selected: new Set(result.numbers.map((n) => pages[n - 1].id)), error: null };
}

/**
 * Re-applies the user's edits of a bookmark's pages to its current pages: `edited` was made
 * starting from `base`. Pages the user added or removed stay added or removed; the rest follows
 * `current`, so pages added or removed somewhere else in the meantime are kept that way too.
 */
export function rebaseSelection(
  base: Iterable<string>,
  edited: ReadonlySet<string>,
  current: Iterable<string>,
): Set<string> {
  const before = new Set(base);
  const next = new Set([...current].filter((id) => edited.has(id) || !before.has(id)));
  for (const id of edited) if (!before.has(id)) next.add(id);
  return next;
}
