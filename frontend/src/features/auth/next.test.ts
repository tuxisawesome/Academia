import { describe, expect, it } from "vitest";
import { safeNext } from "./next";

const origin = "https://academia.example";

describe("safeNext", () => {
  it("keeps in-app paths", () => {
    expect(safeNext("/f/abc", origin)).toBe("/f/abc");
    expect(safeNext("/search?q=heart&in=x", origin)).toBe("/search?q=heart&in=x");
    expect(safeNext("/read/n/1#p4", origin)).toBe("/read/n/1#p4");
  });

  it("falls back to the library for anything off-site", () => {
    for (const next of [null, "", "f/abc", "//evil.com", "/\\evil.com", "/\t/evil.com", "https://evil.com/", "javascript:alert(1)"]) {
      expect(safeNext(next, origin)).toBe("/");
    }
  });
});
