import { describe, expect, it } from "vitest";
import { ApiError, apiUrl, isNotFound, isPageError } from "./client";

describe("isPageError", () => {
  const notFound = new ApiError(404, "not_found", "Not found.");
  const serverError = new ApiError(500, "http_error", "Request failed (500).");

  it("replaces the page when nothing has loaded", () => {
    expect(isPageError(serverError, false)).toBe(true);
    expect(isPageError(notFound, false)).toBe(true);
  });

  it("keeps loaded data when a refetch fails", () => {
    expect(isPageError(serverError, true)).toBe(false);
    expect(isPageError(new ApiError(0, "network", "Offline."), true)).toBe(false);
  });

  it("replaces loaded data once the item is gone", () => {
    expect(isPageError(notFound, true)).toBe(true);
  });

  it("is false without an error", () => {
    expect(isPageError(null, false)).toBe(false);
    expect(isNotFound(serverError)).toBe(false);
  });
});

describe("apiUrl", () => {
  it("leaves out empty parameters", () => {
    expect(apiUrl("/search", { q: "", in: null, from: undefined, to: "2026-03-01" })).toBe("/api/search?to=2026-03-01");
  });

  it("repeats a parameter for each value of a list", () => {
    expect(apiUrl("/search", { q: "a b", class: ["c1", "c2"] })).toBe("/api/search?q=a+b&class=c1&class=c2");
    expect(apiUrl("/search", { class: [] })).toBe("/api/search");
  });
});
