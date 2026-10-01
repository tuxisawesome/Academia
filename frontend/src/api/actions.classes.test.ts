import { afterEach, describe, expect, it, vi } from "vitest";
import { createClass, deleteClass, reorderClasses, updateClass } from "./actions";
import { queryClient } from "./queries";
import type { ClassItem } from "./types";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const item = (id: string, position = 0): ClassItem => ({ id, name: id, color: null, position, page_count: 0 });

/** Answers every request with `body` and records what was sent. */
function server(status: number, body: unknown) {
  const sent: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined });
      return json(status, body);
    }),
  );
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
});

describe("class actions", () => {
  it("shows a new class at once, so a picker can select it", async () => {
    queryClient.setQueryData(["classes"], [item("a")]);
    const sent = server(200, item("b", 1));
    const created = await createClass("b");
    expect(created.id).toBe("b");
    expect(sent[0]).toMatchObject({ url: "/api/classes", method: "POST", body: { name: "b", color: null } });
    expect(queryClient.getQueryData<ClassItem[]>(["classes"])?.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("sends a removed color as clear_color", async () => {
    queryClient.setQueryData(["classes"], [item("a")]);
    const sent = server(200, { ...item("a"), name: "Physics" });
    await updateClass("a", { color: null });
    await updateClass("a", { color: "navy" });
    await updateClass("a", { name: "Physics" });
    expect(sent.map((r) => r.body)).toEqual([{ clear_color: true }, { color: "navy" }, { name: "Physics" }]);
    expect(sent[0]).toMatchObject({ url: "/api/classes/a", method: "PATCH" });
    expect(queryClient.getQueryData<ClassItem[]>(["classes"])?.[0].name).toBe("Physics");
  });

  it("reloads the pages on screen after deleting a class", async () => {
    queryClient.setQueryData(["notebook", "nb1"], { id: "nb1" });
    queryClient.setQueryData(["search", "q", "root"], { files: [] });
    server(200, { ok: true });
    await deleteClass("a");
    expect(queryClient.getQueryState(["notebook", "nb1"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["search", "q", "root"])?.isInvalidated).toBe(true);
  });

  it("shows a new order before the server answers, and reloads it if that fails", async () => {
    queryClient.setQueryData(["classes"], [item("a", 0), item("b", 1), item("c", 2)]);
    let answer!: (r: Response) => void;
    const fetchMock = vi.fn((_url: string, _init: RequestInit) => new Promise<Response>((resolve) => (answer = resolve)));
    vi.stubGlobal("fetch", fetchMock);
    const done = reorderClasses(["c", "a", "b"]);
    expect(queryClient.getQueryData<ClassItem[]>(["classes"])?.map((c) => c.id)).toEqual(["c", "a", "b"]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ class_ids: ["c", "a", "b"] });
    answer(json(400, { error: { code: "bad_order", message: "Reload and try again." } }));
    await expect(done).rejects.toMatchObject({ code: "bad_order" });
    expect(queryClient.getQueryState(["classes"])?.isInvalidated).toBe(true);
  });

  it("saves quick moves one after the other, and keeps showing the last", async () => {
    queryClient.setQueryData(["classes"], [item("a", 0), item("b", 1), item("c", 2)]);
    const answers: ((r: Response) => void)[] = [];
    const fetchMock = vi.fn(
      (_url: string, _init: RequestInit) => new Promise<Response>((resolve) => answers.push(resolve)),
    );
    vi.stubGlobal("fetch", fetchMock);
    // Moving "c" up twice.
    const first = reorderClasses(["a", "c", "b"]);
    const second = reorderClasses(["c", "a", "b"]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    answers[0](json(200, [item("a", 0), item("c", 1), item("b", 2)]));
    await first;
    // The first answer doesn't bring back the order from before the second move.
    expect(queryClient.getQueryData<ClassItem[]>(["classes"])?.map((c) => c.id)).toEqual(["c", "a", "b"]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toEqual({ class_ids: ["c", "a", "b"] });
    answers[1](json(200, [item("c", 0), item("a", 1), item("b", 2)]));
    await second;
    expect(queryClient.getQueryData<ClassItem[]>(["classes"])?.map((c) => c.id)).toEqual(["c", "a", "b"]);
  });
});
