import type { Prefs } from "../../api/types";

/** Same values as pdf.js's SpreadMode. */
export const Spread = { NONE: 0, ODD: 1, EVEN: 2 } as const;
export type SpreadValue = (typeof Spread)[keyof typeof Spread];

/**
 * Two pages side by side on wide, landscape-ish screens; one page otherwise.
 * "Cover alone" starts spreads on even pages (1 | 2–3 | 4–5 …) like a printed book.
 */
export function spreadModeFor(
  layout: Prefs["reader"]["layout"],
  coverAlone: boolean,
  width: number,
  height: number,
): SpreadValue {
  const double = coverAlone ? Spread.EVEN : Spread.ODD;
  if (layout === "single") return Spread.NONE;
  if (layout === "double") return double;
  return width >= 820 && width > height * 1.15 ? double : Spread.NONE;
}

/** 1-based page numbers shown together with `page`. */
export function spreadPages(page: number, total: number, spread: number): number[] {
  if (spread === Spread.NONE || total <= 1) return [page];
  let start: number;
  if (spread === Spread.ODD) start = page % 2 === 1 ? page : page - 1;
  else {
    if (page === 1) return [1];
    start = page % 2 === 0 ? page : page - 1;
  }
  return [start, start + 1].filter((p) => p >= 1 && p <= total);
}
