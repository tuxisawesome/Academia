import { describe, expect, it } from "vitest";
import { parseZoomLevel, ZOOM_STEPS } from "./PageGrid";

describe("parseZoomLevel", () => {
  it("uses the fallback when nothing is stored", () => {
    expect(parseZoomLevel(null, 1)).toBe(1);
    expect(parseZoomLevel("", 2)).toBe(2);
  });

  it("keeps a valid stored level, including level 0", () => {
    expect(parseZoomLevel("0", 1)).toBe(0);
    expect(parseZoomLevel("3", 1)).toBe(3);
  });

  it("ignores out-of-range or garbage values", () => {
    expect(parseZoomLevel(String(ZOOM_STEPS.length), 1)).toBe(1);
    expect(parseZoomLevel("-1", 1)).toBe(1);
    expect(parseZoomLevel("1.5", 1)).toBe(1);
    expect(parseZoomLevel("big", 1)).toBe(1);
  });
});
