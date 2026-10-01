import { describe, expect, it } from "vitest";
import type { ClassItem } from "../api/types";
import { formatDay } from "../lib/format";
import { tagSummary } from "./PageTags";

const classes = new Map<string, ClassItem>(
  ["Physics", "Lab", "Maths"].map((name, i) => [`c${i}`, { id: `c${i}`, name, color: null, position: i, page_count: 1 }]),
);

describe("tagSummary", () => {
  it("is empty for a page without tags", () => {
    expect(tagSummary([{ date: null, class_ids: [] }], classes)).toBe("");
  });

  it("lists the date, then the classes in the user's order", () => {
    expect(tagSummary([{ date: "2026-03-05", class_ids: ["c1", "c0"] }], classes)).toBe(
      `${formatDay("2026-03-05")} · Physics, Lab`,
    );
  });

  it("combines the pages of a spread", () => {
    const pages = [
      { date: "2026-03-06", class_ids: ["c2"] },
      { date: "2026-03-05", class_ids: ["c2", "c0"] },
    ];
    expect(tagSummary(pages, classes)).toBe(`${formatDay("2026-03-05")}, ${formatDay("2026-03-06")} · Physics, Maths`);
  });

  it("leaves out classes it doesn't know (yet)", () => {
    expect(tagSummary([{ date: null, class_ids: ["c0", "gone"] }], classes)).toBe("Physics");
    expect(tagSummary([{ date: null, class_ids: ["c0"] }], undefined)).toBe("");
  });
});

describe("formatDay", () => {
  it("shows the calendar date as stored, whatever the time zone", () => {
    const local = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });
    expect(formatDay("2026-03-05")).toBe(local.format(new Date(2026, 2, 5)));
    expect(formatDay("2026-03-05")).toContain("2026");
    expect(formatDay("2026-03-05", true)).not.toContain("2026");
  });
});
