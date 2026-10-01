import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

export const useIsNarrow = () => useMediaQuery("(max-width: 760px)");
export const useIsCoarse = () => useMediaQuery("(pointer: coarse)");
/** Running as an installed app window, where browser shortcuts such as Ctrl+Shift+N reach the page. */
export const useIsInstalledApp = () =>
  useMediaQuery("(display-mode: standalone), (display-mode: window-controls-overlay)");

export function useElementSize<T extends HTMLElement>(ref: RefObject<T | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

export function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

/** Keeps a ref pointing at the latest value (for use inside stable event handlers). */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

export function useDocumentTitle(title: string | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · Academia` : "Academia";
  }, [title]);
}

export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

/**
 * Radix's ContextMenu also opens on a touch or pen long-press by itself, and some platforms (iOS)
 * fire no contextmenu event then. Put `onPointerDownCapture`/`onContextMenuCapture` on the trigger
 * and `onOpenChange` on the Root: a menu that opens without a contextmenu event calls `onTarget`
 * with the pressed element, so it gets the targets a right-click there would.
 */
export function useLongPressMenu(onTarget: (target: HTMLElement) => void) {
  const pressed = useRef<HTMLElement | null>(null);
  return {
    onPointerDownCapture: (e: React.PointerEvent) => {
      pressed.current = e.pointerType === "mouse" ? null : (e.target as HTMLElement);
    },
    onContextMenuCapture: () => {
      pressed.current = null;
    },
    onOpenChange: (open: boolean) => {
      if (open && pressed.current) onTarget(pressed.current);
      pressed.current = null;
    },
  };
}
