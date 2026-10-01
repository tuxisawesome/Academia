import { describe, expect, it } from "vitest";
import { pageAfterLayoutChange, Spread, spreadLabel, spreadModeFor, spreadPages } from "./spreads";

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

describe("spreadLabel", () => {
  it("joins neighbouring pages with a dash", () => {
    expect(spreadLabel([3, 4])).toBe("3–4");
    expect(spreadLabel([5])).toBe("5");
  });

  it("lists a bookmark's pages that are not neighbours in the notebook", () => {
    // A bookmark of notebook pages 3, 7 and 10 shows 3 and 7 side by side.
    expect(spreadLabel([3, 7])).toBe("3, 7");
    expect(spreadLabel([7, 10])).toBe("7, 10");
  });
});

describe("pageAfterLayoutChange", () => {
  it("returns to the right-hand page the reader was on before the spread", () => {
    // p. 4 in one-page mode; the spread 3–4 makes p. 3 current.
    expect(pageAfterLayoutChange(3, 10, Spread.ODD, 4)).toBe(4);
    expect(pageAfterLayoutChange(2, 10, Spread.EVEN, 3)).toBe(3);
  });

  it("follows pages turned since", () => {
    expect(pageAfterLayoutChange(5, 10, Spread.ODD, 4)).toBe(5);
    expect(pageAfterLayoutChange(7, 10, Spread.NONE, 4)).toBe(7);
    expect(pageAfterLayoutChange(3, 10, Spread.ODD, null)).toBe(3);
  });
});
