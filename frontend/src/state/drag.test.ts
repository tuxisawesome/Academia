import { afterEach, describe, expect, it } from "vitest";
import { queryClient } from "../api/queries";
import type { TreeFolder } from "../api/types";
import { canDropInto, currentDrag, endNodeDrag, guardFileDrops, startNodeDrag, withDescendants } from "./drag";

const folder = (id: string, parent_id: string | null): TreeFolder => ({ id, parent_id, name: id, color: null });

// physics ─ week1 ─ day1
//         └ week2
// maths
const tree = [
  folder("physics", null),
  folder("week1", "physics"),
  folder("day1", "week1"),
  folder("week2", "physics"),
  folder("maths", null),
];

describe("withDescendants", () => {
  it("includes the folders and everything below them", () => {
    expect(withDescendants(["physics"], tree)).toEqual(new Set(["physics", "week1", "day1", "week2"]));
    expect(withDescendants(["week1", "maths"], tree)).toEqual(new Set(["week1", "day1", "maths"]));
  });

  it("keeps ids missing from the tree", () => {
    expect(withDescendants(["new"], tree)).toEqual(new Set(["new"]));
  });
});

describe("canDropInto", () => {
  const fakeDrag = () =>
    ({ dataTransfer: { setData: () => undefined, setDragImage: () => undefined } }) as unknown as React.DragEvent;

  it("refuses a dragged folder's own subfolders", () => {
    queryClient.setQueryData(["tree"], tree);
    startNodeDrag(fakeDrag(), ["physics"], ["physics"], new Map([["physics", null]]), "physics");
    expect(canDropInto("physics")).toBe(false);
    expect(canDropInto("week1")).toBe(false);
    expect(canDropInto("day1")).toBe(false);
    expect(canDropInto("maths")).toBe(true);
    expect(canDropInto(null)).toBe(false); // it is already there
    endNodeDrag();
  });
});

describe("guardFileDrops", () => {
  guardFileDrops();

  const dragEvent = (type: string, types: string[]) => {
    const e = new Event(type, { cancelable: true, bubbles: true });
    Object.defineProperty(e, "dataTransfer", { value: { types, dropEffect: "copy" } });
    return e as DragEvent;
  };

  it("keeps a file dropped outside any drop zone from opening in the tab", () => {
    const over = dragEvent("dragover", ["Files"]);
    document.body.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer!.dropEffect).toBe("none");
    const drop = dragEvent("drop", ["Files"]);
    document.body.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
  });

  it("leaves drop zones and other drags alone", () => {
    const zone = document.createElement("div");
    document.body.appendChild(zone);
    zone.addEventListener("dragover", (e) => e.preventDefault());
    const over = dragEvent("dragover", ["Files"]);
    zone.dispatchEvent(over);
    expect(over.dataTransfer!.dropEffect).toBe("copy");
    zone.remove();

    const text = dragEvent("dragover", ["text/plain"]);
    document.body.dispatchEvent(text);
    expect(text.defaultPrevented).toBe(false);
  });
});

function fakeDragEvent() {
  return {
    dataTransfer: { effectAllowed: "", setData: () => {}, setDragImage: () => {} },
  } as unknown as React.DragEvent;
}

function drag(origins: [string, string | null][], folderIds: string[] = []) {
  startNodeDrag(fakeDragEvent(), origins.map(([id]) => id), folderIds, new Map(origins), "label");
}

afterEach(endNodeDrag);

describe("canDropInto with items from several folders", () => {
  it("refuses the folder every dragged item is already in", () => {
    drag([
      ["a", "X"],
      ["b", "X"],
    ]);
    expect(canDropInto("X")).toBe(false);
    expect(canDropInto("Y")).toBe(true);
    expect(canDropInto(null)).toBe(true);
  });

  it("lets search results from several folders be dropped on the Library root and on their folders", () => {
    drag([
      ["a", "X"],
      ["b", "Y"],
    ]);
    expect(canDropInto(null)).toBe(true);
    expect(canDropInto("X")).toBe(true);
    drag([["c", null]]);
    expect(canDropInto(null)).toBe(false);
  });

  it("never drops a folder into itself", () => {
    drag([["f", null]], ["f"]);
    expect(canDropInto("f")).toBe(false);
  });

  it("remembers where each dragged item came from", () => {
    drag([
      ["a", "X"],
      ["b", "Y"],
    ]);
    expect([...currentDrag()!.origins]).toEqual([
      ["a", "X"],
      ["b", "Y"],
    ]);
  });
});
