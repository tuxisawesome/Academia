import { describe, expect, it } from "vitest";
import type { LibraryNode } from "../../api/types";
import { sortNodes } from "./sorting";

const node = (name: string, kind: LibraryNode["kind"], extra: Partial<LibraryNode> = {}): LibraryNode => ({
  id: name,
  name,
  kind,
  color: null,
  parent_id: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  trashed_at: null,
  ...extra,
});

describe("sortNodes", () => {
  const items = [
    node("Week 10", "notebook", { page_count: 3, updated_at: "2026-03-01T00:00:00Z" }),
    node("Week 2", "notebook", { page_count: 30, updated_at: "2026-02-01T00:00:00Z" }),
    node("zeta", "folder"),
    node("Alpha", "bookmark", { page_count: 2 }),
    node("beta", "folder"),
  ];

  it("keeps folders first and sorts names naturally", () => {
    expect(sortNodes(items, { key: "name", dir: "asc" }).map((n) => n.name)).toEqual([
      "beta",
      "zeta",
      "Alpha",
      "Week 2",
      "Week 10",
    ]);
  });

  it("sorts descending while keeping folders first", () => {
    expect(sortNodes(items, { key: "name", dir: "desc" }).map((n) => n.name)).toEqual([
      "zeta",
      "beta",
      "Week 10",
      "Week 2",
      "Alpha",
    ]);
  });

  it("sorts by pages and by date", () => {
    expect(sortNodes(items, { key: "pages", dir: "asc" }).slice(2).map((n) => n.name)).toEqual([
      "Alpha",
      "Week 10",
      "Week 2",
    ]);
    expect(sortNodes(items, { key: "modified", dir: "desc" })[2].name).toBe("Week 10");
  });
});
