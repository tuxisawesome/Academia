import { describe, expect, it } from "vitest";
import { marqueeRect } from "./useMarquee";

describe("marqueeRect", () => {
  const bounds = { width: 800, height: 1200 };

  it("spans the start point and the pointer in any direction", () => {
    expect(marqueeRect({ x: 100, y: 100 }, { x: 300, y: 250 }, bounds)).toEqual({
      left: 100,
      top: 100,
      width: 200,
      height: 150,
    });
    expect(marqueeRect({ x: 300, y: 250 }, { x: 100, y: 100 }, bounds)).toEqual({
      left: 100,
      top: 100,
      width: 200,
      height: 150,
    });
  });

  it("stops at the edges of the content when the pointer leaves it", () => {
    // Pointer far below and right of the scroll area: the rectangle must not grow the scroll size.
    expect(marqueeRect({ x: 100, y: 1000 }, { x: 950, y: 1600 }, bounds)).toEqual({
      left: 100,
      top: 1000,
      width: 700,
      height: 200,
    });
    expect(marqueeRect({ x: 100, y: 100 }, { x: -40, y: -30 }, bounds)).toEqual({
      left: 0,
      top: 0,
      width: 100,
      height: 100,
    });
  });
});
