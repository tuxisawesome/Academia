import { describe, expect, it } from "vitest";
import { isTagDay } from "./format";
import { filtersFromParams, hasFilters, withFilters } from "./searchFilters";

describe("search filters in the URL", () => {
  it("reads repeated classes and the date range", () => {
    const params = new URLSearchParams("q=notes&class=c1&class=c2&from=2026-03-01&to=2026-03-31");
    expect(filtersFromParams(params)).toEqual({ classes: ["c1", "c2"], from: "2026-03-01", to: "2026-03-31" });
  });

  it("is empty without filters", () => {
    const filters = filtersFromParams(new URLSearchParams("q=notes&in=f1"));
    expect(filters).toEqual({ classes: [], from: null, to: null });
    expect(hasFilters(filters)).toBe(false);
  });

  it("drops empty and repeated classes and malformed dates", () => {
    const params = new URLSearchParams("class=&class=c1&class=c1&from=yesterday&to=2026-3-1");
    expect(filtersFromParams(params)).toEqual({ classes: ["c1"], from: null, to: null });
    // Dates the server would refuse.
    const refused = new URLSearchParams("from=2026-02-30&to=0002-03-01");
    expect(filtersFromParams(refused)).toEqual({ classes: [], from: null, to: null });
  });

  it("writes filters, keeping the query and scope", () => {
    const params = new URLSearchParams("q=notes&in=f1&class=old&to=2025-01-01");
    const next = withFilters(params, { classes: ["c1", "c2"], from: "2026-03-01", to: null });
    expect(next.toString()).toBe("q=notes&in=f1&class=c1&class=c2&from=2026-03-01");
    // The original is left as it was.
    expect(params.getAll("class")).toEqual(["old"]);
  });

  it("round-trips", () => {
    const filters = { classes: ["c2", "c1"], from: null, to: "2026-12-31" };
    expect(filtersFromParams(withFilters(new URLSearchParams(), filters))).toEqual(filters);
    expect(hasFilters(filters)).toBe(true);
    expect(hasFilters({ classes: [], from: "2026-01-01", to: null })).toBe(true);
  });

  it("clears every filter", () => {
    const params = new URLSearchParams("q=x&class=c1&from=2026-01-01&to=2026-02-01");
    expect(withFilters(params, { classes: [], from: null, to: null }).toString()).toBe("q=x");
  });
});

describe("isTagDay", () => {
  it("accepts real dates from 1900 to 2200", () => {
    for (const day of ["2026-03-05", "2024-02-29", "1900-01-01", "2200-12-31"]) expect(isTagDay(day)).toBe(true);
  });

  it("refuses other dates, and the years a date input goes through while one is typed", () => {
    const refused = ["2025-02-29", "2026-13-01", "2026-04-31", "1899-12-31", "2201-01-01", "0002-03-05", "20260-01-01"];
    for (const day of refused) expect(isTagDay(day)).toBe(false);
  });
});
