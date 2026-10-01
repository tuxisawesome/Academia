import { afterEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "../api/queries";
import type { User } from "../api/types";
import { appendToNotebook, useUploads } from "./uploads";

/**
 * Stands in for XMLHttpRequest: an upload stays open while signed in (or succeeds with `accept`),
 * and gets a 401 once signed out.
 */
class FakeXHR {
  static sent: string[] = [];
  static signedIn = true;
  static accept = false;
  url = "";
  status = 0;
  response: unknown = null;
  responseType = "";
  upload = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {}
  getResponseHeader() {
    return null;
  }
  send() {
    FakeXHR.sent.push(this.url);
    if (FakeXHR.signedIn && !FakeXHR.accept) return;
    setTimeout(() => {
      this.status = FakeXHR.signedIn ? 201 : 401;
      this.response = FakeXHR.signedIn
        ? { id: "s1" }
        : { error: { code: "unauthenticated", message: "Please sign in." } };
      this.onload?.();
    });
  }
  abort() {
    this.onabort?.();
  }
}

const alice = { id: "alice", username: "alice" } as User;
const pdf = (name: string) => new File(["%PDF-1.7"], name, { type: "application/pdf" });

afterEach(() => {
  vi.unstubAllGlobals();
  FakeXHR.sent = [];
  FakeXHR.signedIn = true;
  FakeXHR.accept = false;
  queryClient.clear();
});

describe("uploads when the session ends", () => {
  it("stops a batch of PDFs dropped on a notebook", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    queryClient.setQueryData(["me"], alice);
    const done = appendToNotebook([pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf")], "nb1");
    // Signed out while a.pdf is uploading.
    FakeXHR.signedIn = false;
    queryClient.setQueryData(["me"], null);
    await done;
    expect(FakeXHR.sent).toEqual(["/api/sources?filename=a.pdf"]);
    expect(useUploads.getState().items).toEqual([]);
  });

  it("does not cache the notebook an append returns once signed out", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    FakeXHR.accept = true;
    // Signed out while the PDF is being added to the notebook.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        FakeXHR.signedIn = false;
        queryClient.setQueryData(["me"], null);
        return new Response(JSON.stringify({ id: "nb1", rev: 2, pages: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    queryClient.setQueryData(["me"], alice);
    await appendToNotebook([pdf("a.pdf")], "nb1");
    expect(queryClient.getQueryData(["notebook", "nb1"])).toBeUndefined();
  });
});
