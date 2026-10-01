import { afterEach, describe, expect, it } from "vitest";
import { applyTheme, themeColorFor } from "./theme";

const LIGHT = "(prefers-color-scheme: light)";
const DARK = "(prefers-color-scheme: dark)";

describe("themeColorFor", () => {
  it("follows the OS scheme for the system theme", () => {
    expect(themeColorFor("system", LIGHT)).toBe("#F5EFE3");
    expect(themeColorFor("system", DARK)).toBe("#191612");
  });

  it("uses the explicit choice whatever the OS scheme", () => {
    expect(themeColorFor("dark", LIGHT)).toBe("#191612");
    expect(themeColorFor("light", DARK)).toBe("#F5EFE3");
  });
});

describe("applyTheme", () => {
  afterEach(() => {
    document.head.innerHTML = "";
    delete document.documentElement.dataset.theme;
  });

  it("updates the theme-color meta tags and restores them for system", () => {
    document.head.innerHTML = `<meta name="theme-color" content="#F5EFE3" media="${LIGHT}"><meta name="theme-color" content="#191612" media="${DARK}">`;
    const metas = () => [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map((m) => m.content);
    applyTheme("dark");
    expect(metas()).toEqual(["#191612", "#191612"]);
    applyTheme("light");
    expect(metas()).toEqual(["#F5EFE3", "#F5EFE3"]);
    applyTheme("system");
    expect(metas()).toEqual(["#F5EFE3", "#191612"]);
  });
});
