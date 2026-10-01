import { QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useClipboard } from "../state/clipboard";
import { useDialogs, confirmDialog } from "../state/dialogs";
import { useUploads } from "../state/uploads";
import { logout, updatePrefs } from "./actions";
import { api, ApiError } from "./client";
import { endedSessionUser, queryClient } from "./queries";
import type { User } from "./types";

function user(id: string, theme: User["prefs"]["theme"] = "system"): User {
  return {
    id,
    username: id,
    display_name: id,
    is_admin: false,
    must_change_password: false,
    disabled: false,
    created_at: "2026-01-01T00:00:00Z",
    last_login_at: null,
    prefs: { theme, view: "grid", sort: { key: "name", dir: "asc" }, reader: { layout: "auto", cover_alone: false } },
  } as User;
}

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

function signIn(u: User) {
  queryClient.setQueryData(["me"], u);
  queryClient.setQueryData(["tree"], [{ id: `${u.id}-folder`, name: `${u.id}'s folder` }]);
  queryClient.setQueryData(["pins"], [{ id: `${u.id}-folder` }]);
}

beforeEach(() => {
  queryClient.setQueryData(["me"], null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session end", () => {
  it("drops the previous user's library when a 401 ends the session", async () => {
    signIn(user("alice"));
    vi.stubGlobal("fetch", respond(401, { error: { code: "unauthenticated", message: "Your session has ended." } }));
    await expect(api("/tree")).rejects.toBeInstanceOf(ApiError);
    expect(queryClient.getQueryData(["me"])).toBeNull();
    expect(queryClient.getQueryData(["tree"])).toBeUndefined();
    expect(queryClient.getQueryData(["pins"])).toBeUndefined();
    expect(endedSessionUser()).toBe("alice");
  });

  it("does not sign out on a wrong password at the sign-in form", async () => {
    signIn(user("alice"));
    vi.stubGlobal("fetch", respond(401, { error: { code: "invalid_credentials", message: "Incorrect." } }));
    await expect(api("/auth/login", { method: "POST", json: {} })).rejects.toBeInstanceOf(ApiError);
    expect(queryClient.getQueryData<User>(["me"])?.id).toBe("alice");
    expect(queryClient.getQueryData(["tree"])).toBeDefined();
  });

  it("resets the cache when another user replaces the signed-in one", () => {
    signIn(user("alice"));
    queryClient.setQueryData(["me"], user("bob"));
    expect(queryClient.getQueryData(["tree"])).toBeUndefined();
    expect(endedSessionUser()).toBe("alice");
  });

  it("keeps the cache when the same user is refreshed", () => {
    signIn(user("alice"));
    queryClient.setQueryData(["me"], user("alice", "dark"));
    expect(queryClient.getQueryData(["tree"])).toBeDefined();
  });

  it("clears the clipboard, upload tray and open dialogs", async () => {
    signIn(user("alice"));
    useClipboard.getState().set("cut", ["n1", "n2"]);
    const abort = vi.fn();
    useUploads.getState().add({ id: 1, name: "alice.pdf", progress: 0.5, status: "uploading", abort });
    const answer = confirmDialog({ title: "Delete forever?" });
    queryClient.setQueryData(["me"], null);
    expect(useClipboard.getState().ids).toEqual([]);
    expect(useClipboard.getState().mode).toBeNull();
    expect(abort).toHaveBeenCalled();
    expect(useUploads.getState().items).toEqual([]);
    expect(useDialogs.getState().pending).toBeNull();
    await expect(answer).resolves.toBe(false);
  });

  it("keeps long-lived ['me'] observers (ThemeSync) attached across sign-out", async () => {
    signIn(user("alice", "light"));
    const observer = new QueryObserver<User | null>(queryClient, { queryKey: ["me"], enabled: false });
    const seen: (string | undefined)[] = [];
    const unsubscribe = observer.subscribe((r) => seen.push(r.data?.prefs.theme));

    vi.stubGlobal("fetch", respond(200, { ok: true }));
    await logout();
    queryClient.setQueryData(["me"], user("bob", "dark"));
    vi.stubGlobal("fetch", respond(200, user("bob", "system")));
    await updatePrefs({ theme: "system" });

    expect(observer.getCurrentResult().data?.prefs.theme).toBe("system");
    expect(seen).toContain("dark");
    unsubscribe();
  });
});

describe("logout", () => {
  it("stays signed in when the server can't be reached", async () => {
    signIn(user("alice"));
    vi.stubGlobal("fetch", respond(503, {}));
    await expect(logout()).rejects.toBeInstanceOf(ApiError);
    expect(queryClient.getQueryData<User>(["me"])?.id).toBe("alice");
  });
});
