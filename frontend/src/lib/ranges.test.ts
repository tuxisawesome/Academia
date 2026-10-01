import { describe, expect, it } from "vitest";
import { formatRanges, parseRanges, rangesLabel, toRanges } from "./ranges";

describe("toRanges", () => {
  it("groups consecutive numbers", () => {
    expect(toRanges([5, 1, 2, 3, 10, 11])).toEqual([
      [1, 3],
      [5, 5],
      [10, 11],
    ]);
    expect(toRanges([])).toEqual([]);
    expect(toRanges([4, 4, 4])).toEqual([[4, 4]]);
  });
});

describe("formatRanges / rangesLabel", () => {
  it("formats with en dashes", () => {
    expect(formatRanges([[3, 7], [10, 10]])).toBe("3–7, 10");
    expect(rangesLabel([[3, 3]])).toBe("p. 3");
    expect(rangesLabel([[3, 4]])).toBe("pp. 3–4");
    expect(rangesLabel([])).toBe("No pages");
  });
});

describe("parseRanges", () => {
  it("parses lists and ranges", () => {
    expect(parseRanges("3-5, 10", 20)).toEqual({ numbers: [3, 4, 5, 10], error: null });
    expect(parseRanges("3–5 8 9", 20).numbers).toEqual([3, 4, 5, 8, 9]);
    expect(parseRanges("7-5", 20).numbers).toEqual([5, 6, 7]);
    expect(parseRanges("18-", 20).numbers).toEqual([18, 19, 20]);
    expect(parseRanges(" 2 - 4 ; 6", 20).numbers).toEqual([2, 3, 4, 6]);
    expect(parseRanges("", 20)).toEqual({ numbers: [], error: null });
  });

  it("reports errors", () => {
    expect(parseRanges("abc", 20).error).toMatch(/isn't a page/);
    expect(parseRanges("0-3", 20).error).toMatch(/1 to 20/);
    expect(parseRanges("21", 20).error).toMatch(/1 to 20/);
  });

  it("round-trips with formatRanges", () => {
    const text = formatRanges(toRanges([1, 2, 3, 7, 9, 10]));
    expect(parseRanges(text, 10).numbers).toEqual([1, 2, 3, 7, 9, 10]);
  });
});
