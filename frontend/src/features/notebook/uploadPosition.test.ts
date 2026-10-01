import { describe, expect, it } from "vitest";
import { afterPageNumber, listedBookmarkIds } from "./uploadPosition";

describe("afterPageNumber", () => {
  it("uses the typed page", () => {
    expect(afterPageNumber("5", 20)).toBe(5);
    expect(afterPageNumber("20", 20)).toBe(20);
  });

  it("rounds decimals to a real page instead of falling off the notebook", () => {
    expect(afterPageNumber("2.4", 20)).toBe(2);
    expect(afterPageNumber("2.5", 20)).toBe(3);
  });

  it("clamps to the notebook's pages", () => {
    expect(afterPageNumber("0", 20)).toBe(1);
    expect(afterPageNumber("-3", 20)).toBe(1);
    expect(afterPageNumber("99", 20)).toBe(20);
  });

  it("falls back to page 1 while the field is empty or not a number", () => {
    expect(afterPageNumber("", 20)).toBe(1);
    expect(afterPageNumber("  ", 20)).toBe(1);
    expect(afterPageNumber("abc", 20)).toBe(1);
  });
});

describe("listedBookmarkIds", () => {
  const listed = [{ bookmark: { id: "ch2" } }, { bookmark: { id: "ch3" } }];

  it("drops checked bookmarks that are no longer listed", () => {
    expect(listedBookmarkIds(new Set(["ch1", "ch2"]), listed)).toEqual(["ch2"]);
  });

  it("sends nothing when no bookmark is listed", () => {
    expect(listedBookmarkIds(["ch1"], [])).toEqual([]);
  });
});
