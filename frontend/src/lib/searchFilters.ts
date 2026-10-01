import type { SearchFilters } from "../api/types";
import { isTagDay } from "./format";

/** The tag filters in a search URL: `class` (repeated), `from` and `to`. */
export function filtersFromParams(params: URLSearchParams): SearchFilters {
  const day = (key: string) => {
    const value = params.get(key);
    return value && isTagDay(value) ? value : null;
  };
  return { classes: [...new Set(params.getAll("class").filter(Boolean))], from: day("from"), to: day("to") };
}

/** `params` with its tag filters replaced by `filters`; everything else (q, in) is kept. */
export function withFilters(params: URLSearchParams, filters: SearchFilters): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of ["class", "from", "to"]) next.delete(key);
  for (const id of filters.classes) next.append("class", id);
  if (filters.from) next.set("from", filters.from);
  if (filters.to) next.set("to", filters.to);
  return next;
}

export function hasFilters(filters: SearchFilters): boolean {
  return filters.classes.length > 0 || !!filters.from || !!filters.to;
}
