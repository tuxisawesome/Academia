import { describe, expect, it } from "vitest";
import { tagChanges, tagState, type PageTagState } from "./tags";

const page = (date: string | null, ...class_ids: string[]) => ({ date, class_ids });

describe("tagState", () => {
  it("gives the date all pages share", () => {
    expect(tagState([page("2026-03-05"), page("2026-03-05")]).date).toBe("2026-03-05");
    expect(tagState([page(null), page(null)]).date).toBeNull();
  });

  it("calls differing dates mixed, also when some pages have none", () => {
    expect(tagState([page("2026-03-05"), page("2026-03-06")]).date).toBe("mixed");
    expect(tagState([page("2026-03-05"), page(null)]).date).toBe("mixed");
  });

  it("splits classes into those on every page and those on some", () => {
    const state = tagState([page(null, "a", "b"), page(null, "b", "c"), page(null, "b")]);
    expect(state.all).toEqual(["b"]);
    expect(state.some).toEqual(["a", "c"]);
  });

  it("has everything on all of one page", () => {
    expect(tagState([page("2026-01-02", "a", "b")])).toEqual({ date: "2026-01-02", all: ["a", "b"], some: [] });
  });
});

describe("tagChanges", () => {
  const initial: PageTagState = { date: "mixed", all: ["a"], some: ["b", "c"] };
  const unchanged = { date: undefined, all: ["a"], some: ["b", "c"] };

  it("is null when nothing changed", () => {
    expect(tagChanges(initial, unchanged)).toBeNull();
  });

  it("leaves a date alone unless it was edited", () => {
    expect(tagChanges({ ...initial, date: "2026-03-05" }, { ...unchanged, date: "2026-03-05" })).toBeNull();
    expect(tagChanges({ ...initial, date: null }, { ...unchanged, date: null })).toBeNull();
  });

  it("sets or clears the date", () => {
    expect(tagChanges(initial, { ...unchanged, date: "2026-03-05" })).toEqual({ date: "2026-03-05" });
    expect(tagChanges(initial, { ...unchanged, date: null })).toEqual({ date: null });
    expect(tagChanges({ ...initial, date: "2026-03-05" }, { ...unchanged, date: null })).toEqual({ date: null });
  });

  it("adds a class to all pages, also one that was on some of them", () => {
    expect(tagChanges(initial, { ...unchanged, all: ["a", "d"] })).toEqual({ addClasses: ["d"] });
    expect(tagChanges(initial, { ...unchanged, all: ["a", "b"], some: ["c"] })).toEqual({ addClasses: ["b"] });
  });

  it("removes classes taken off every page, whether they were on all or some", () => {
    expect(tagChanges(initial, { ...unchanged, all: [], some: ["c"] })).toEqual({ removeClasses: ["a", "b"] });
  });

  it("sends a date and classes together", () => {
    expect(tagChanges(initial, { date: null, all: ["d"], some: ["b"] })).toEqual({
      date: null,
      addClasses: ["d"],
      removeClasses: ["a", "c"],
    });
  });
});
