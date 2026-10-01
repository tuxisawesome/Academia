import type { ClassItem, PageRef } from "../api/types";
import { folderColorVar } from "../lib/colors";
import { formatDay } from "../lib/format";

type Tagged = Pick<PageRef, "date" | "class_ids">;

/** Thumbnails have room for this many class names; more are counted. */
const MAX_NAMES = 2;

/** The dates and classes of `pages` between them, classes in the user's order. */
function pageTags(pages: Tagged[], classes: Map<string, ClassItem> | undefined) {
  const dates = [...new Set(pages.map((p) => p.date).filter((d): d is string => !!d))].sort();
  const ids = new Set(pages.flatMap((p) => p.class_ids));
  const items = classes ? [...classes.values()].filter((c) => ids.has(c.id)) : [];
  return { dates, items };
}

/** The tags of `pages` in words ("Mar 5, 2026 · Physics, Lab"), or "" when they have none. */
export function tagSummary(pages: Tagged[], classes: Map<string, ClassItem> | undefined): string {
  const { dates, items } = pageTags(pages, classes);
  return [dates.map((d) => formatDay(d)).join(", "), items.map((c) => c.name).join(", ")].filter(Boolean).join(" · ");
}

/**
 * The date and classes of one page (a thumbnail) or of the pages on screen (the reader).
 * `compact` shows only colored dots for the classes and leaves the year out of the date; the
 * full names are in the tooltip either way.
 */
export function PageTags({
  pages,
  classes,
  compact = false,
  className = "",
}: {
  pages: Tagged[];
  classes: Map<string, ClassItem> | undefined;
  compact?: boolean;
  className?: string;
}) {
  const { dates, items } = pageTags(pages, classes);
  if (!dates.length && !items.length) return null;
  const summary = tagSummary(pages, classes);
  const named = compact ? [] : items.slice(0, MAX_NAMES);
  const dotted = compact ? items : items.slice(MAX_NAMES);
  return (
    <span className={`page-tags ${compact ? "compact" : ""} ${className}`} title={summary}>
      <span className="sr-only">{summary}</span>
      {dates.length > 0 && (
        <span className="tag-date tabular" aria-hidden="true">
          {dates.map((d) => formatDay(d, compact)).join(", ")}
        </span>
      )}
      {named.map((c) => (
        <span key={c.id} className="tag-class" aria-hidden="true">
          <span className="class-dot" style={{ background: folderColorVar(c.color) }} />
          <span className="truncate">{c.name}</span>
        </span>
      ))}
      {dotted.length > 0 && (
        <span className="tag-dots" aria-hidden="true">
          {dotted.map((c) => (
            <span key={c.id} className="class-dot" style={{ background: folderColorVar(c.color) }} />
          ))}
        </span>
      )}
    </span>
  );
}
