import { describe, expect, it } from "vitest";
import { rebaseSelection, selectionForRangeText } from "./selection";

const pages = Array.from({ length: 40 }, (_, i) => ({ id: `p${i + 1}` }));
const ids = (...numbers: number[]) => new Set(numbers.map((n) => `p${n}`));

describe("selectionForRangeText", () => {
  const before = ids(3, 4, 5, 6, 7);

  it("selects the typed pages", () => {
    expect(selectionForRangeText("1-2, 12", pages, before)).toEqual({ selected: ids(1, 2, 12), error: null });
    expect(selectionForRangeText("38-", pages, before).selected).toEqual(ids(38, 39, 40));
    expect(selectionForRangeText("", pages, before)).toEqual({ selected: new Set(), error: null });
  });

  it("keeps the selection from before typing while the text is invalid", () => {
    // Typing "125-130" in a 40-page notebook: "12" is valid on the way, the full text is not.
    expect(selectionForRangeText("12", pages, before).selected).toEqual(ids(12));
    for (const text of ["125", "125-", "125-130"]) {
      const result = selectionForRangeText(text, pages, before);
      expect(result.error).toMatch(/1 to 40/);
      expect(result.selected).toEqual(before);
    }
    const typo = selectionForRangeText("3-7, 1x", pages, before);
    expect(typo.error).toMatch(/isn't a page/);
    expect(typo.selected).toEqual(before);
  });
});

describe("rebaseSelection", () => {
  it("keeps pages added or removed elsewhere when the user changed nothing", () => {
    // The bookmark had pp. 1–3; page 7 was added to it somewhere else.
    expect(rebaseSelection(["p1", "p2", "p3"], ids(1, 2, 3), ["p1", "p2", "p3", "p7"])).toEqual(ids(1, 2, 3, 7));
    expect(rebaseSelection(["p1", "p2", "p3"], ids(1, 2, 3), ["p1", "p3"])).toEqual(ids(1, 3));
  });

  it("re-applies the user's own additions and removals", () => {
    // The user removed p2 and added p9 while p7 was added elsewhere.
    expect(rebaseSelection(["p1", "p2", "p3"], ids(1, 3, 9), ["p1", "p2", "p3", "p7"])).toEqual(ids(1, 3, 7, 9));
  });

  it("does not bring back pages removed elsewhere", () => {
    expect(rebaseSelection(["p1", "p2"], ids(1, 2, 5), ["p1"])).toEqual(ids(1, 5));
  });
});
