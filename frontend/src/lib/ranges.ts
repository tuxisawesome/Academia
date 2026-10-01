/**
 * Page-range helpers. Page numbers are 1-based; ranges are inclusive.
 */

export type Range = [number, number];

/** Groups page numbers into sorted runs: [1,2,3,5] -> [[1,3],[5,5]]. */
export function toRanges(numbers: Iterable<number>): Range[] {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const runs: Range[] = [];
  for (const n of sorted) {
    const last = runs[runs.length - 1];
    if (last && last[1] === n - 1) last[1] = n;
    else runs.push([n, n]);
  }
  return runs;
}

/** "3–7, 10, 12–15" (en dashes). */
export function formatRanges(ranges: Range[]): string {
  return ranges.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(", ");
}

export function rangesLabel(ranges: Range[]): string {
  if (ranges.length === 0) return "No pages";
  const single = ranges.length === 1 && ranges[0][0] === ranges[0][1];
  return `${single ? "p." : "pp."} ${formatRanges(ranges)}`;
}

export interface ParseResult {
  numbers: number[];
  error: string | null;
}

/**
 * Parses text like "3-7, 10 12–15" into page numbers within 1..max.
 * Accepts hyphens, en/em dashes, commas, semicolons and whitespace.
 */
export function parseRanges(text: string, max: number): ParseResult {
  const out = new Set<number>();
  const cleaned = text.replace(/[–—]/g, "-").replace(/\s*-\s*/g, "-").trim();
  if (!cleaned) return { numbers: [], error: null };
  const parts = cleaned.split(/[,;\s]+/).filter(Boolean);
  for (const raw of parts) {
    const part = raw;
    const m = /^(\d+)(?:-(\d+)?)?$/.exec(part);
    if (!m) return { numbers: [...out].sort((a, b) => a - b), error: `“${raw}” isn't a page or range.` };
    const a = Number(m[1]);
    const b = m[2] !== undefined ? Number(m[2]) : part.endsWith("-") ? max : a;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (lo < 1 || hi > max) {
      return { numbers: [...out].sort((x, y) => x - y), error: `Pages go from 1 to ${max}.` };
    }
    for (let n = lo; n <= hi; n++) out.add(n);
  }
  return { numbers: [...out].sort((a, b) => a - b), error: null };
}
