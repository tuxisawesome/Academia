import { describe, expect, it } from "vitest";
import { Spread, spreadModeFor, spreadPages } from "./spreads";

describe("spreadModeFor", () => {
  it("uses two pages only on wide screens in automatic mode", () => {
    expect(spreadModeFor("auto", false, 1400, 900)).toBe(Spread.ODD);
    expect(spreadModeFor("auto", true, 1400, 900)).toBe(Spread.EVEN);
    expect(spreadModeFor("auto", false, 390, 844)).toBe(Spread.NONE);
    expect(spreadModeFor("auto", false, 900, 1000)).toBe(Spread.NONE);
  });
  it("respects explicit choices", () => {
    expect(spreadModeFor("single", false, 1400, 900)).toBe(Spread.NONE);
    expect(spreadModeFor("double", false, 390, 844)).toBe(Spread.ODD);
  });
});

describe("spreadPages", () => {
  it("pairs 1–2, 3–4 in odd spreads", () => {
    expect(spreadPages(1, 10, Spread.ODD)).toEqual([1, 2]);
    expect(spreadPages(4, 10, Spread.ODD)).toEqual([3, 4]);
    expect(spreadPages(9, 9, Spread.ODD)).toEqual([9]);
  });
  it("shows the cover alone in even spreads", () => {
    expect(spreadPages(1, 10, Spread.EVEN)).toEqual([1]);
    expect(spreadPages(2, 10, Spread.EVEN)).toEqual([2, 3]);
    expect(spreadPages(3, 10, Spread.EVEN)).toEqual([2, 3]);
    expect(spreadPages(10, 10, Spread.EVEN)).toEqual([10]);
  });
  it("shows single pages without spreads", () => {
    expect(spreadPages(5, 10, Spread.NONE)).toEqual([5]);
  });
});
