import { describe, expect, it } from "vitest";
import { groupByParent } from "./parents";

describe("groupByParent", () => {
  it("groups ids by folder in first-seen order, with null for the Library root", () => {
    expect(
      groupByParent([
        ["a", "X"],
        ["b", "Y"],
        ["c", null],
        ["d", "X"],
      ]),
    ).toEqual([
      ["X", ["a", "d"]],
      ["Y", ["b"]],
      [null, ["c"]],
    ]);
  });

  it("accepts a Map of id → parent", () => {
    expect(groupByParent(new Map([["a", "X"]]))).toEqual([["X", ["a"]]]);
    expect(groupByParent([])).toEqual([]);
  });
});
