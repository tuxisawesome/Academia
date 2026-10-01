import { QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergePrefs, pinFolders, reorderPins, setFolderColor, updatePrefs } from "./actions";
import { api, ApiError } from "./client";
import { queryClient } from "./queries";
import type { PinnedFolder, Prefs, User } from "./types";

const prefs: Prefs = {
  theme: "system",
  view: "grid",
  sort: { key: "modified", dir: "asc" },
  reader: { layout: "auto", cover_alone: true },
};

const alice = {
  id: "alice",
  username: "alice",
  display_name: "Alice",
  is_admin: false,
  must_change_password: false,
  disabled: false,
  created_at: "2026-01-01T00:00:00Z",
  last_login_at: null,
  prefs,
} as User;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const pin = (id: string) => ({ id, name: id }) as unknown as PinnedFolder;

beforeEach(() => {
  queryClient.setQueryData(["me"], alice);
});

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.setQueryData(["me"], null);
});

describe("mergePrefs", () => {
  it("merges sort and reader field by field", () => {
    expect(mergePrefs(prefs, { reader: { layout: "double" } }).reader).toEqual({ layout: "double", cover_alone: true });
    expect(mergePrefs(prefs, { sort: { dir: "desc" } }).sort).toEqual({ key: "modified", dir: "desc" });
    expect(mergePrefs(prefs, { theme: "dark" })).toEqual({ ...prefs, theme: "dark" });
  });
});

describe("updatePrefs", () => {
  it("sends only the changed fields", async () => {
    const fetch = vi.fn(async () => json(200, alice));
    vi.stubGlobal("fetch", fetch);
    await updatePrefs({ reader: { layout: "double" } });
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({ reader: { layout: "double" } });
  });

  it("reloads the server's copy instead of restoring a snapshot when saving fails", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("/api/auth/me")) return json(200, alice);
        calls++;
        return json(500, { error: { code: "db_locked", message: "Try again." } });
      }),
    );
    // ThemeSync keeps ["me"] observed, so an invalidation refetches it.
    const observer = new QueryObserver<User>(queryClient, { queryKey: ["me"], queryFn: () => api<User>("/auth/me") });
    const unsubscribe = observer.subscribe(() => {});
    // Two changes in flight: the second one's snapshot holds the first one's optimistic theme.
    const first = updatePrefs({ theme: "dark" });
    const second = updatePrefs({ view: "list" });
    await expect(first).rejects.toBeInstanceOf(ApiError);
    await expect(second).rejects.toBeInstanceOf(ApiError);
    expect(calls).toBe(2);
    await vi.waitFor(() => expect(queryClient.getQueryData<User>(["me"])?.prefs).toEqual(prefs));
    unsubscribe();
  });
});

describe("partial failures refresh the UI", () => {
  it("setFolderColor refreshes the folders that were saved and rethrows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/nodes/bad") ? json(409, { error: { code: "trashed", message: "In the Trash." } }) : json(200, {}),
      ),
    );
    queryClient.setQueryData(["nodes", "root"], { items: [] });
    await expect(setFolderColor(["a", "bad", "c"], "teal")).rejects.toThrow("In the Trash.");
    expect(queryClient.getQueryState(["nodes", "root"])?.isInvalidated).toBe(true);
  });

  it("pinFolders reloads the pins when a later pin fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) =>
        JSON.parse(init.body as string).node_id === "b"
          ? json(400, { error: { code: "too_many_pins", message: "You can pin at most 100 folders." } })
          : json(200, [pin("a")]),
      ),
    );
    queryClient.setQueryData(["pins"], []);
    await expect(pinFolders(["a", "b"])).rejects.toThrow("at most 100");
    expect(queryClient.getQueryState(["pins"])?.isInvalidated).toBe(true);
  });

  it("reorderPins drops its optimistic order when saving fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(500, {})));
    queryClient.setQueryData(["pins"], [pin("a"), pin("b")]);
    await expect(reorderPins(["b", "a"])).rejects.toBeInstanceOf(ApiError);
    expect(queryClient.getQueryState(["pins"])?.isInvalidated).toBe(true);
  });
});
