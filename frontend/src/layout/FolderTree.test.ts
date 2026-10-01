import { describe, expect, it } from "vitest";
import type { TreeFolder } from "../api/types";
import { buildTree, revealPlan } from "./FolderTree";

const folder = (id: string, parent_id: string | null): TreeFolder => ({ id, parent_id, name: id, color: null });

describe("revealPlan", () => {
  const { byId } = buildTree([folder("physics", null), folder("week1", "physics"), folder("lab", "week1")]);

  it("opens the ancestors of a newly opened folder, nearest first", () => {
    expect(revealPlan(byId, "lab", undefined)).toEqual({ key: "lab/week1/physics", open: ["week1", "physics"] });
  });

  it("does nothing again for the same folder when the tree changes elsewhere", () => {
    const rebuilt = buildTree([...byId.values(), folder("chemistry", null)]).byId;
    expect(revealPlan(rebuilt, "lab", "lab/week1/physics")).toBeNull();
  });

  it("reveals again once the folder has moved", () => {
    const moved = buildTree([folder("physics", null), folder("week1", "physics"), folder("lab", "physics")]).byId;
    expect(revealPlan(moved, "lab", "lab/week1/physics")).toEqual({ key: "lab/physics", open: ["physics"] });
  });

  it("waits until the folder is in the tree", () => {
    expect(revealPlan(new Map(), "lab", undefined)).toBeNull();
  });
});
