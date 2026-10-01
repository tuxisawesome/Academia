import { afterEach, describe, expect, it, vi } from "vitest";
import { createBookmark, deletePages, reorderPages, rotatePages, setBookmarkPages, undeletePages } from "./actions";
import { queryClient } from "./queries";
import type { NotebookDetail } from "./types";

type Body = Record<string, unknown>;

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function notebook(id: string, rev: number, pageIds = ["p1", "p2", "p3"]): NotebookDetail {
  return {
    id,
    kind: "notebook",
    name: "Notes",
    color: null,
    parent_id: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    trashed_at: null,
    rev,
    pdf_digest: `digest-${rev}`,
    page_count: pageIds.length,
    path: [],
    pages: pageIds.map((pid, index) => ({ id: pid, source_id: "s1", index, rotation: 0, width: 600, height: 800 })),
    bookmarks: [],
  };
}

/** Stands in for the server: like check_rev in pages.py, a base_rev other than the current rev is a 409. */
function fakeServer(id: string, rev: number) {
  const server = { rev, sent: [] as Body[] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Body;
      server.sent.push(body);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (body.base_rev != null && body.base_rev !== server.rev) {
        return reply(409, { error: { code: "stale_rev", message: "This notebook was changed somewhere else." } });
      }
      server.rev += 1;
      return reply(200, notebook(id, server.rev));
    }),
  );
  return server;
}

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
});

describe("notebook edits", () => {
  it("sends a quick second edit with the rev the first one produced", async () => {
    const nb = notebook("nb-twice", 1);
    const server = fakeServer(nb.id, 1);
    // Pressing `]` twice before the first response arrives: both calls see the same rendered rev.
    await Promise.all([rotatePages(nb, ["p1"], 90), rotatePages(nb, ["p1"], 90)]);
    expect(server.sent.map((body) => body.base_rev)).toEqual([1, 2]);
    expect(server.rev).toBe(3);
  });

  it("keeps two quick drags in order", async () => {
    const nb = notebook("nb-drags", 4);
    const server = fakeServer(nb.id, 4);
    await Promise.all([reorderPages(nb, ["p2", "p3", "p1"]), reorderPages(nb, ["p3", "p1", "p2"])]);
    expect(server.sent).toEqual([
      { base_rev: 4, page_ids: ["p2", "p3", "p1"] },
      { base_rev: 5, page_ids: ["p3", "p1", "p2"] },
    ]);
  });

  it("still reports a change made somewhere else", async () => {
    const nb = notebook("nb-elsewhere", 1);
    const server = fakeServer(nb.id, 2); // another device has changed it since
    const results = await Promise.allSettled([rotatePages(nb, ["p1"], 90), rotatePages(nb, ["p1"], 90)]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(results.map((r) => r.status === "rejected" && r.reason.status)).toEqual([409, 409]);
    expect(server.rev).toBe(2);
  });

  it("moves past the user's own undo, which sends no rev", async () => {
    const nb = notebook("nb-undo", 1);
    const server = fakeServer(nb.id, 1);
    queryClient.setQueryData(["notebook", nb.id], nb);
    const afterDelete = await deletePages(nb, ["p1"]);
    // Undo, then rotate before the undo's response has been rendered.
    await Promise.all([undeletePages(nb.id, "batch-1"), rotatePages(afterDelete, ["p2"], 90)]);
    expect(server.sent.map((body) => body.base_rev)).toEqual([1, undefined, 3]);
    expect(server.rev).toBe(4);
  });
});

describe("bookmark edits", () => {
  it("sends the rev the editor started from", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => reply(200, { id: "bm1", rev: 5 }));
    vi.stubGlobal("fetch", fetchMock);
    await setBookmarkPages("bm1", ["p1", "p7"], 4);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ page_ids: ["p1", "p7"], base_rev: 4 });
  });

  it("reloads the notebook and bookmark when the save conflicts", async () => {
    queryClient.setQueryData(["notebook", "nb1"], notebook("nb1", 1));
    queryClient.setQueryData(["bookmark", "bm2"], { id: "bm2", rev: 1 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(409, { error: { code: "stale_rev", message: "This bookmark was changed somewhere else." } })),
    );
    await expect(setBookmarkPages("bm2", ["p1"], 1)).rejects.toMatchObject({ status: 409, code: "stale_rev" });
    expect(queryClient.getQueryState(["notebook", "nb1"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["bookmark", "bm2"])?.isInvalidated).toBe(true);
  });

  it("reloads the notebook when selected pages were deleted elsewhere", async () => {
    queryClient.setQueryData(["notebook", "nb2"], notebook("nb2", 1));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(409, { error: { code: "stale_pages", message: "Some selected pages are no longer in the notebook." } })),
    );
    await expect(createBookmark(null, "Week 1", "nb2", ["p1"])).rejects.toMatchObject({ code: "stale_pages" });
    expect(queryClient.getQueryState(["notebook", "nb2"])?.isInvalidated).toBe(true);
  });
});
