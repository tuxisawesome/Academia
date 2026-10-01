import { afterEach, describe, expect, it } from "vitest";
import { isPageShortcut } from "./shortcuts";

function setup() {
  document.body.innerHTML = `
    <div class="notebook-page">
      <button id="toolbar">Rotate</button>
      <a id="crumb" href="/">Library</a>
      <input id="field" />
      <div id="grid" class="page-grid" tabindex="0"><div data-page-index="0"><button id="zoom">+</button></div></div>
    </div>
    <div id="portal"><div role="menuitem" id="item">Insert PDF after</div><button id="close">Close</button></div>`;
  const page = document.querySelector(".notebook-page")!;
  const at = (id: string, key: string) => isPageShortcut({ key, target: document.getElementById(id), currentTarget: page });
  return { at };
}

describe("isPageShortcut", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("handles keys pressed in the page grid", () => {
    const { at } = setup();
    for (const key of ["Enter", "Delete", "Backspace", "[", "]", "a", "Escape"]) expect(at("grid", key)).toBe(true);
  });

  it("ignores keys bubbling out of portaled menus and dialogs", () => {
    const { at } = setup();
    for (const key of ["Enter", "Delete", "Backspace", "[", "]", "Escape"]) {
      expect(at("item", key)).toBe(false);
      expect(at("close", key)).toBe(false);
    }
  });

  it("leaves Enter on buttons and links to their own action", () => {
    const { at } = setup();
    expect(at("toolbar", "Enter")).toBe(false);
    expect(at("zoom", "Enter")).toBe(false);
    expect(at("crumb", "Enter")).toBe(false);
    expect(at("toolbar", "Delete")).toBe(true);
    expect(at("toolbar", "Escape")).toBe(true);
  });

  it("ignores typing in fields", () => {
    const { at } = setup();
    expect(at("field", "Backspace")).toBe(false);
  });
});
