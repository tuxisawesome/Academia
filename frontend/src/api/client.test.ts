import { describe, expect, it } from "vitest";
import { ApiError, isNotFound, isPageError } from "./client";

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
