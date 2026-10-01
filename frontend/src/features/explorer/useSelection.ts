import { useCallback, useEffect, useRef, useState } from "react";

export interface ClickModifiers {
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

/** Explorer-style multi-selection over an ordered list of ids. */
export function useSelection(orderedIds: string[]) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);

  // Drop ids that are no longer listed.
  useEffect(() => {
    setSelected((prev) => {
      const valid = new Set(orderedIds);
      const next = new Set([...prev].filter((id) => valid.has(id)));
      return next.size === prev.size ? prev : next;
    });
    if (anchor.current && !orderedIds.includes(anchor.current)) anchor.current = null;
  }, [orderedIds]);

  const click = useCallback(
    (id: string, mods: ClickModifiers = {}) => {
      const additive = mods.ctrlKey || mods.metaKey;
      if (mods.shiftKey && anchor.current && orderedIds.includes(anchor.current)) {
        const a = orderedIds.indexOf(anchor.current);
        const b = orderedIds.indexOf(id);
        const range = orderedIds.slice(Math.min(a, b), Math.max(a, b) + 1);
        setSelected((prev) => new Set(additive ? [...prev, ...range] : range));
      } else if (additive) {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        anchor.current = id;
      } else {
        setSelected(new Set([id]));
        anchor.current = id;
      }
      setFocused(id);
    },
    [orderedIds],
  );

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    anchor.current = id;
    setFocused(id);
  }, []);

  const selectOnly = useCallback((id: string) => {
    setSelected(new Set([id]));
    anchor.current = id;
    setFocused(id);
  }, []);

  const set = useCallback((ids: Iterable<string>) => setSelected(new Set(ids)), []);
  const clear = useCallback(() => setSelected(new Set()), []);
  const selectAll = useCallback(() => setSelected(new Set(orderedIds)), [orderedIds]);

  return { selected, click, toggle, selectOnly, set, clear, selectAll, focused, setFocused, anchor };
}

export type Selection = ReturnType<typeof useSelection>;
