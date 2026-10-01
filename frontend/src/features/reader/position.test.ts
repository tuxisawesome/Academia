import { describe, expect, it } from "vitest";
import { startPage } from "./position";

const pages = ["a", "b", "c", "d", "e"].map((id) => ({ id }));

describe("startPage", () => {
  it("prefers ?page= over the saved position", () => {
    expect(startPage("2", pages, { page_id: "d", page_index: 3 })).toBe(2);
    expect(startPage("99", pages, null)).toBe(5);
  });

  it("opens at the saved page, wherever it moved", () => {
    expect(startPage(null, pages, { page_id: "d", page_index: 0 })).toBe(4);
    expect(startPage("", pages, { page_id: "b", page_index: 4 })).toBe(2);
  });

  it("opens near a saved page that was deleted", () => {
    expect(startPage(null, pages, { page_id: "gone", page_index: 2 })).toBe(3);
    expect(startPage(null, pages, { page_id: "gone", page_index: 24 })).toBe(5);
    expect(startPage(null, pages, { page_id: null, page_index: 0 })).toBe(1);
  });

  it("only returns whole page numbers", () => {
    expect(startPage("2.5", pages, null)).toBe(2);
    expect(startPage("abc", pages, { page_id: "c", page_index: 2 })).toBe(3);
    expect(startPage("-3", pages, null)).toBe(1);
    expect(Number.isInteger(startPage("Infinity", pages, null))).toBe(true);
  });

  it("starts at the first page without a saved position", () => {
    expect(startPage(null, pages)).toBe(1);
  });
});
