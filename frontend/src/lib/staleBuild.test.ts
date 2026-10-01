import { beforeEach, describe, expect, it, vi } from "vitest";
import { isChunkLoadError, reloadForNewBuild } from "./staleBuild";

describe("isChunkLoadError", () => {
  it("recognises failed dynamic imports in each browser", () => {
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: https://x/assets/ReaderPage-1.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module: https://x/assets/ReaderPage-1.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new Error("Unable to preload CSS for /assets/ReaderPage-1.css"))).toBe(true);
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe("reloadForNewBuild", () => {
  beforeEach(() => sessionStorage.clear());

  it("reloads once, then not again within the interval", () => {
    const reload = vi.fn();
    expect(reloadForNewBuild(reload, 100_000)).toBe(true);
    expect(reloadForNewBuild(reload, 105_000)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reloadForNewBuild(reload, 120_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("doesn't reload while offline", () => {
    const reload = vi.fn();
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    expect(reloadForNewBuild(reload, 100_000)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    onLine.mockRestore();
  });
});
