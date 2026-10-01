import { describe, expect, it } from "vitest";
import { buildTree } from "../../layout/FolderTree";
import { visibleRows } from "./dialogs";

describe("visibleRows", () => {
  const { roots } = buildTree([
    { id: "b", parent_id: null, name: "Biology", color: null },
    { id: "a", parent_id: null, name: "Archive", color: null },
    { id: "a1", parent_id: "a", name: "2024", color: null },
    { id: "a1x", parent_id: "a1", name: "Exams", color: null },
  ]);
  const ids = (expanded: string[]) => visibleRows(roots, new Set(expanded)).map((r) => r?.id ?? null);

  it("lists the Library, then the folders in display order", () => {
    expect(ids([])).toEqual([null, "a", "b"]);
  });

  it("includes the children of expanded folders only", () => {
    expect(ids(["a"])).toEqual([null, "a", "a1", "b"]);
    expect(ids(["a", "a1"])).toEqual([null, "a", "a1", "a1x", "b"]);
    // A collapsed parent hides its expanded children.
    expect(ids(["a1"])).toEqual([null, "a", "b"]);
  });
});
