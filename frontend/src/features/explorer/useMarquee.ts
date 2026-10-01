import { useRef, useState, type RefObject } from "react";

export interface MarqueeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The rectangle from the start point `s` to the pointer `p`, kept inside the content area
 * (`width` x `height`, the container's scroll size). Reaching past it would grow the scroll area,
 * and auto-scroll would then run on into blank space.
 */
export function marqueeRect(
  s: { x: number; y: number },
  p: { x: number; y: number },
  bounds: { width: number; height: number },
): MarqueeRect {
  const x = Math.max(0, Math.min(bounds.width, p.x));
  const y = Math.max(0, Math.min(bounds.height, p.y));
  return { left: Math.min(s.x, x), top: Math.min(s.y, y), width: Math.abs(x - s.x), height: Math.abs(y - s.y) };
}

/**
 * Rubber-band selection inside a scrollable container. Items are elements carrying
 * `data-node-id`. Starts only on empty space with the primary mouse/pen button.
 */
export function useMarquee(
  containerRef: RefObject<HTMLElement | null>,
  handlers: {
    onStart?: () => void;
    onChange: (ids: string[], additive: boolean) => void;
    onClickEmpty: () => void;
  },
) {
  const [rect, setRect] = useState<MarqueeRect | null>(null);
  const state = useRef<{
    x: number;
    y: number;
    additive: boolean;
    moved: boolean;
    bounds: { width: number; height: number };
    items: { id: string; left: number; top: number; right: number; bottom: number }[];
  } | null>(null);

  function toContent(e: { clientX: number; clientY: number }) {
    const el = containerRef.current!;
    const box = el.getBoundingClientRect();
    return { x: e.clientX - box.left + el.scrollLeft, y: e.clientY - box.top + el.scrollTop };
  }

  function onPointerDown(e: React.PointerEvent) {
    const el = containerRef.current;
    if (!el || e.button !== 0 || e.pointerType === "touch") return;
    const target = e.target as HTMLElement;
    if (target.closest("[data-node-id], button, input, a, .no-marquee")) return;
    const box = el.getBoundingClientRect();
    // Ignore clicks on the scrollbar.
    if (e.clientX > box.left + el.clientWidth || e.clientY > box.top + el.clientHeight) return;
    const p = toContent(e);
    const items = [...el.querySelectorAll<HTMLElement>("[data-node-id]")].map((node) => {
      const r = node.getBoundingClientRect();
      const left = r.left - box.left + el.scrollLeft;
      const top = r.top - box.top + el.scrollTop;
      return { id: node.dataset.nodeId!, left, top, right: left + r.width, bottom: top + r.height };
    });
    state.current = {
      x: p.x,
      y: p.y,
      additive: e.ctrlKey || e.metaKey || e.shiftKey,
      moved: false,
      bounds: { width: el.scrollWidth, height: el.scrollHeight },
      items,
    };
    handlers.onStart?.();
    el.setPointerCapture(e.pointerId);
    el.focus({ preventScroll: true });
  }

  function onPointerMove(e: React.PointerEvent) {
    const s = state.current;
    const el = containerRef.current;
    if (!s || !el) return;
    const p = toContent(e);
    if (!s.moved && Math.hypot(p.x - s.x, p.y - s.y) < 4) return;
    s.moved = true;
    // Auto-scroll near the edges.
    const box = el.getBoundingClientRect();
    if (e.clientY < box.top + 30) el.scrollTop -= 14;
    else if (e.clientY > box.bottom - 30) el.scrollTop += 14;
    const r = marqueeRect(s, p, s.bounds);
    setRect(r);
    const hits = s.items
      .filter((i) => i.right >= r.left && i.left <= r.left + r.width && i.bottom >= r.top && i.top <= r.top + r.height)
      .map((i) => i.id);
    handlers.onChange(hits, s.additive);
  }

  function onPointerUp(e: React.PointerEvent) {
    const s = state.current;
    state.current = null;
    setRect(null);
    const el = containerRef.current;
    if (el?.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    if (s && !s.moved && !s.additive) handlers.onClickEmpty();
  }

  return { rect, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp } };
}
