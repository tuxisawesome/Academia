import { describe, expect, it } from "vitest";
import type { ClassItem } from "../api/types";
import { classNamed, cleanClassName, foldName, matchClasses } from "./classes";

function classes(...names: string[]): ClassItem[] {
  return names.map((name, i) => ({ id: `c${i}`, name, color: null, position: i, page_count: 0 }));
}

const names = (items: ClassItem[]) => items.map((c) => c.name);

describe("matchClasses", () => {
  const all = classes("Organic Chemistry", "Économie", "Physics", "Biochemistry", "Physical Education");

  it("lists every class, in order, for no text", () => {
    expect(names(matchClasses(all, ""))).toEqual(names(all));
    expect(names(matchClasses(all, "   "))).toEqual(names(all));
  });

  it("ignores case and accents", () => {
    expect(names(matchClasses(all, "ECON"))).toEqual(["Économie"]);
    expect(names(matchClasses(all, "économie"))).toEqual(["Économie"]);
    expect(names(matchClasses(all, "Ökonomie"))).toEqual([]);
  });

  it("puts names starting with the text first", () => {
    expect(names(matchClasses(all, "chem"))).toEqual(["Organic Chemistry", "Biochemistry"]);
    expect(names(matchClasses(all, "phys"))).toEqual(["Physics", "Physical Education"]);
    expect(names(matchClasses(all, "istry"))).toEqual(["Organic Chemistry", "Biochemistry"]);
  });

  it("matches text with extra spaces like the name it will be saved as", () => {
    expect(names(matchClasses(all, "  organic   chem "))).toEqual(["Organic Chemistry"]);
  });
});

describe("classNamed", () => {
  const all = classes("Physics", "Économie");

  it("finds a class by its name, ignoring case and spacing", () => {
    expect(classNamed(all, "physics")?.id).toBe("c0");
    expect(classNamed(all, "  PHYSICS ")?.id).toBe("c0");
    expect(classNamed(all, "ÉCONOMIE")?.id).toBe("c1");
  });

  it("counts accents and whole names, like the server's duplicate check", () => {
    expect(classNamed(all, "Economie")).toBeUndefined();
    expect(classNamed(all, "Phys")).toBeUndefined();
    expect(classNamed(all, "")).toBeUndefined();
  });

  it("compares composed and decomposed accents alike", () => {
    expect(classNamed(all, "Économie")?.id).toBe("c1");
  });
});

describe("cleanClassName and foldName", () => {
  it("cleans a name the way the server saves it", () => {
    expect(cleanClassName("  Organic \t Chemistry  ")).toBe("Organic Chemistry");
    expect(cleanClassName("Économie")).toBe("Économie");
  });

  it("folds case and accents away", () => {
    expect(foldName("Économie Ångström")).toBe("economie angstrom");
  });
});
