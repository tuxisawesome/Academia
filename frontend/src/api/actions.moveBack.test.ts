import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { path: string; json?: unknown }[] = [];
const nodes: Record<string, { trashed_at: string | null }> = {};

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return {
    ...actual,
    api: vi.fn(async (path: string, options: { json?: unknown } = {}) => {
      calls.push({ path, json: options.json });
      const id = path.match(/^\/nodes\/([^/]+)$/)?.[1];
      if (id && id !== "move") {
        if (!nodes[id]) throw new actual.ApiError(404, "not_found", "Not found.");
        return nodes[id];
      }
      return {};
    }),
  };
});
vi.mock("./queries", () => ({ invalidateLibrary: vi.fn(async () => {}), queryClient: {} }));

const { liveNodeIds, moveBack } = await import("./actions");

beforeEach(() => {
  calls.length = 0;
  for (const key of Object.keys(nodes)) delete nodes[key];
});

describe("moveBack", () => {
  it("puts every item back into its own folder", async () => {
    await moveBack(
      new Map([
        ["a", "X"],
        ["b", "Y"],
        ["c", "X"],
        ["d", null],
      ]),
    );
    expect(calls).toEqual([
      { path: "/nodes/move", json: { ids: ["a", "c"], target_id: "X" } },
      { path: "/nodes/move", json: { ids: ["b"], target_id: "Y" } },
      { path: "/nodes/move", json: { ids: ["d"], target_id: null } },
    ]);
  });
});

describe("liveNodeIds", () => {
  it("leaves out items that are in the Trash or deleted", async () => {
    nodes.a = { trashed_at: null };
    nodes.b = { trashed_at: "2026-01-01T00:00:00Z" };
    nodes.d = { trashed_at: null };
    expect(await liveNodeIds(["a", "b", "c", "d"])).toEqual(["a", "d"]);
  });
});
