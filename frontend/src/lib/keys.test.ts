import { describe, expect, it } from "vitest";
import { isImeKey, shortcutKey } from "./keys";

describe("shortcutKey", () => {
  it("uses the typed Latin letter", () => {
    expect(shortcutKey({ key: "c", code: "KeyC" })).toBe("c");
    expect(shortcutKey({ key: "N", code: "KeyN" })).toBe("n");
    // AZERTY: the A key sits where QWERTY has Q.
    expect(shortcutKey({ key: "a", code: "KeyQ" })).toBe("a");
  });

  it("falls back to the physical key on non-Latin layouts", () => {
    expect(shortcutKey({ key: "с", code: "KeyC" })).toBe("c"); // Russian
    expect(shortcutKey({ key: "ψ", code: "KeyC" })).toBe("c"); // Greek
    expect(shortcutKey({ key: "Т", code: "KeyN" })).toBe("n"); // Russian with Shift
    expect(shortcutKey({ key: "ש", code: "KeyA" })).toBe("a"); // Hebrew
  });

  it("leaves other keys alone", () => {
    expect(shortcutKey({ key: "Delete", code: "Delete" })).toBe("delete");
    expect(shortcutKey({ key: "é", code: "Digit2" })).toBe("é");
    expect(shortcutKey({ key: "[", code: "BracketLeft" })).toBe("[");
  });
});

describe("isImeKey", () => {
  it("flags keys sent during or right after an IME composition", () => {
    expect(isImeKey({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isImeKey({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isImeKey({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isImeKey({ isComposing: false, keyCode: 27 })).toBe(false);
  });
});
