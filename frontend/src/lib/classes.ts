import type { ClassItem } from "../api/types";

/** A name folded for matching what is typed: case and accents are ignored ("econ" finds "Économie"). */
export function foldName(name: string): string {
  return name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** A class name as the server saves it: NFC, with runs of spaces collapsed and trimmed. */
export function cleanClassName(name: string): string {
  return name.normalize("NFC").split(/\s+/).filter(Boolean).join(" ");
}

/** The classes whose names contain `text`, those starting with it first; all of them for no text. */
export function matchClasses(classes: ClassItem[], text: string): ClassItem[] {
  const q = foldName(cleanClassName(text));
  if (!q) return classes;
  const starts: ClassItem[] = [];
  const contains: ClassItem[] = [];
  for (const c of classes) {
    const name = foldName(c.name);
    if (name.startsWith(q)) starts.push(c);
    else if (name.includes(q)) contains.push(c);
  }
  return [...starts, ...contains];
}

/** The class called `text`, ignoring case like the server's duplicate check (accents count). */
export function classNamed(classes: ClassItem[], text: string): ClassItem | undefined {
  const name = cleanClassName(text).toLowerCase();
  return name ? classes.find((c) => c.name.toLowerCase() === name) : undefined;
}
