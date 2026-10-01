import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, ZoomIn } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useClassMap } from "../../api/queries";
import type { PageRef } from "../../api/types";
import { PageTags, tagSummary } from "../../components/PageTags";
import { PageThumb } from "../../components/PageThumb";
import { useElementSize } from "../../lib/hooks";

const GAP = 14;
const PAD = 18;
const LABEL_H = 26;
/** Narrower tiles show a page's classes as colored dots, without their names. */
const NAMED_TAGS_MIN = 160;

export interface PageGridHandle {
  scrollToIndex: (index: number) => void;
}

export interface PageGridProps {
  pages: PageRef[];
  mode: "edit" | "pick";
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  tileWidth: number;
  /** Colors of bookmark ribbons per page id. */
  markers?: Map<string, string[]>;
  /** Pages to emphasize (e.g. while hovering a bookmark). */
  highlight?: Set<string> | null;
  /** Label under each tile. Defaults to the 1-based position. */
  labelFor?: (index: number, page: PageRef) => string;
  onReorder?: (order: string[]) => void;
  onOpen?: (index: number) => void;
  onPreview?: (index: number) => void;
  /** Right-click on a page (edit mode): lets the parent set up its context menu. */
  onPageContextMenu?: (pageId: string | null) => void;
  ariaLabel?: string;
}

interface DragState {
  kind: "reorder" | "paint" | "marquee";
  startX: number;
  startY: number;
  /** Start point in content coordinates, so it stays put while the grid scrolls. */
  originX: number;
  originY: number;
  startIndex: number;
  pageId: string | null;
  moved: boolean;
  base: Set<string>;
  paintAdd: boolean;
  additive: boolean;
}

export const PageGrid = forwardRef<PageGridHandle, PageGridProps>(function PageGrid(props, ref) {
  const {
    pages,
    mode,
    selected,
    onSelectedChange,
    tileWidth,
    markers,
    highlight,
    labelFor,
    onReorder,
    onOpen,
    onPreview,
    onPageContextMenu,
    ariaLabel,
  } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const classes = useClassMap();
  const { width } = useElementSize(scrollRef);
  const tileHeight = Math.round(tileWidth * 1.3);
  const colW = tileWidth + GAP;
  const rowH = tileHeight + LABEL_H + GAP;
  const cols = Math.max(1, Math.floor((Math.max(width, tileWidth + PAD * 2) - PAD * 2 + GAP) / colW));
  const rows = Math.ceil(pages.length / cols);
  const gridWidth = cols * colW - GAP;
  const offsetX = Math.max(PAD, Math.floor((width - gridWidth) / 2));

  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 3,
    paddingStart: PAD,
    paddingEnd: 60,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [rowH, cols, virtualizer]);

  useImperativeHandle(ref, () => ({
    scrollToIndex: (index: number) => virtualizer.scrollToIndex(Math.floor(index / cols), { align: "center" }),
  }));

  // Id of the page Shift-click ranges start from (an index would go stale when pages change).
  const anchor = useRef<string | null>(null);
  const drag = useRef<DragState | null>(null);
  // Time of the last drag/paint gesture; the click that follows it is ignored.
  const gestureEnd = useRef(0);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const autoScroll = useRef<number | null>(null);
  const lastPointer = useRef<{ x: number; y: number } | null>(null);

  /** Pointer position in grid content coordinates. */
  const toContent = useCallback((clientX: number, clientY: number) => {
    const el = scrollRef.current!;
    const box = el.getBoundingClientRect();
    return { x: clientX - box.left - offsetX, y: clientY - box.top + el.scrollTop - PAD };
  }, [offsetX]);

  const indexAt = useCallback(
    (clientX: number, clientY: number, clamp = true): number | null => {
      const p = toContent(clientX, clientY);
      let row = Math.floor(p.y / rowH);
      let col = Math.floor(p.x / colW);
      if (!clamp && (row < 0 || row >= rows || col < 0 || col >= cols)) return null;
      row = Math.max(0, Math.min(rows - 1, row));
      col = Math.max(0, Math.min(cols - 1, col));
      const idx = row * cols + col;
      return Math.min(idx, pages.length - 1);
    },
    [toContent, rowH, colW, rows, cols, pages.length],
  );

  const gapAt = useCallback(
    (clientX: number, clientY: number): number => {
      const p = toContent(clientX, clientY);
      const row = Math.max(0, Math.min(rows - 1, Math.floor(p.y / rowH)));
      const col = Math.max(0, Math.min(cols, Math.round((p.x + GAP / 2) / colW)));
      return Math.max(0, Math.min(pages.length, row * cols + col));
    },
    [toContent, rows, rowH, cols, colW, pages.length],
  );

  function anchorIndex(): number | null {
    const i = anchor.current === null ? -1 : pages.findIndex((p) => p.id === anchor.current);
    return i < 0 ? null : i;
  }

  function stopAutoScroll() {
    if (autoScroll.current !== null) cancelAnimationFrame(autoScroll.current);
    autoScroll.current = null;
  }

  function runAutoScroll() {
    const el = scrollRef.current;
    const p = lastPointer.current;
    if (!el || !p || !drag.current) return stopAutoScroll();
    const box = el.getBoundingClientRect();
    let dy = 0;
    if (p.y < box.top + 50) dy = -Math.ceil((box.top + 50 - p.y) / 4);
    else if (p.y > box.bottom - 50) dy = Math.ceil((p.y - (box.bottom - 50)) / 4);
    if (dy) {
      el.scrollTop += dy;
      updateDrag(p.x, p.y);
    }
    autoScroll.current = requestAnimationFrame(runAutoScroll);
  }

  function updateDrag(clientX: number, clientY: number) {
    const d = drag.current;
    if (!d) return;
    if (d.kind === "reorder") {
      setDropIndex(gapAt(clientX, clientY));
    } else if (d.kind === "paint") {
      const idx = indexAt(clientX, clientY);
      if (idx === null) return;
      const lo = Math.min(d.startIndex, idx);
      const hi = Math.max(d.startIndex, idx);
      const next = new Set(d.base);
      for (let i = lo; i <= hi; i++) {
        if (d.paintAdd) next.add(pages[i].id);
        else next.delete(pages[i].id);
      }
      onSelectedChange(next);
    } else {
      const a = { x: d.originX, y: d.originY };
      const b = toContent(clientX, clientY);
      const r = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
      setMarquee(r);
      const c0 = Math.max(0, Math.floor(r.x / colW));
      const c1 = Math.min(cols - 1, Math.floor((r.x + r.w) / colW));
      const r0 = Math.max(0, Math.floor(r.y / rowH));
      const r1 = Math.min(rows - 1, Math.floor((r.y + r.h) / rowH));
      const next = new Set(d.additive ? d.base : []);
      for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) {
          const x0 = col * colW;
          const y0 = row * rowH;
          const hit = x0 + tileWidth >= r.x && x0 <= r.x + r.w && y0 + tileHeight + LABEL_H >= r.y && y0 <= r.y + r.h;
          const idx = row * cols + col;
          if (hit && idx < pages.length) next.add(pages[idx].id);
        }
      }
      onSelectedChange(next);
    }
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    const tile = (e.target as HTMLElement).closest<HTMLElement>("[data-page-index]");
    if ((e.target as HTMLElement).closest("button, input")) return;
    const touch = e.pointerType === "touch";
    const origin = toContent(e.clientX, e.clientY);
    if (tile) {
      const index = Number(tile.dataset.pageIndex);
      const page = pages[index];
      if (mode === "pick") {
        if (touch) return; // taps toggle via click; dragging scrolls
        const a = anchorIndex();
        if (e.shiftKey && a !== null) {
          const lo = Math.min(a, index);
          const hi = Math.max(a, index);
          const next = new Set(selected);
          for (let i = lo; i <= hi; i++) next.add(pages[i].id);
          onSelectedChange(next);
          return;
        }
        const add = !selected.has(page.id);
        const next = new Set(selected);
        if (add) next.add(page.id);
        else next.delete(page.id);
        onSelectedChange(next);
        anchor.current = page.id;
        drag.current = {
          kind: "paint",
          startX: e.clientX,
          startY: e.clientY,
          originX: origin.x,
          originY: origin.y,
          startIndex: index,
          pageId: page.id,
          moved: false,
          base: selected,
          paintAdd: add,
          additive: false,
        };
      } else {
        if (touch || !onReorder) return;
        drag.current = {
          kind: "reorder",
          startX: e.clientX,
          startY: e.clientY,
          originX: origin.x,
          originY: origin.y,
          startIndex: index,
          pageId: page.id,
          moved: false,
          base: selected,
          paintAdd: false,
          additive: false,
        };
      }
    } else if (mode === "edit" && !touch) {
      // Ignore presses on the grid's scrollbar.
      const el = scrollRef.current!;
      const box = el.getBoundingClientRect();
      if (e.clientX > box.left + el.clientWidth || e.clientY > box.top + el.clientHeight) return;
      drag.current = {
        kind: "marquee",
        startX: e.clientX,
        startY: e.clientY,
        originX: origin.x,
        originY: origin.y,
        startIndex: -1,
        pageId: null,
        moved: false,
        base: selected,
        paintAdd: false,
        additive: e.ctrlKey || e.metaKey || e.shiftKey,
      };
    } else {
      return;
    }
    scrollRef.current?.focus({ preventScroll: true });
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    lastPointer.current = { x: e.clientX, y: e.clientY };
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 6) return;
      d.moved = true;
      scrollRef.current?.setPointerCapture(e.pointerId);
      if (d.kind === "reorder" && d.pageId && !selected.has(d.pageId)) {
        d.base = new Set([d.pageId]);
        onSelectedChange(d.base);
      }
      if (autoScroll.current === null) autoScroll.current = requestAnimationFrame(runAutoScroll);
    }
    updateDrag(e.clientX, e.clientY);
  }

  /** Ends the current gesture without applying it and returns its state. */
  function endDrag(e: React.PointerEvent): DragState | null {
    const d = drag.current;
    drag.current = null;
    stopAutoScroll();
    const el = scrollRef.current;
    if (el?.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    setDropIndex(null);
    setMarquee(null);
    return d;
  }

  function onPointerUp(e: React.PointerEvent) {
    const d = endDrag(e);
    if (!d) return;
    if (d.kind === "reorder" && d.moved && onReorder) {
      const target = gapAt(e.clientX, e.clientY);
      const moving = pages.filter((p) => d.base.has(p.id)).map((p) => p.id);
      const movingSet = new Set(moving);
      const before = pages.slice(0, target).filter((p) => !movingSet.has(p.id)).length;
      const rest = pages.filter((p) => !movingSet.has(p.id)).map((p) => p.id);
      const order = [...rest.slice(0, before), ...moving, ...rest.slice(before)];
      if (order.some((id, i) => id !== pages[i].id)) onReorder(order);
    }
    if (d.kind === "marquee" && !d.moved && !d.additive) onSelectedChange(new Set());
    if (d.moved || d.kind === "paint") gestureEnd.current = Date.now();
  }

  // A cancelled gesture (e.g. the browser took a pen drag over for panning) is never applied.
  function onPointerCancel(e: React.PointerEvent) {
    endDrag(e);
  }

  function onTileClick(e: React.MouseEvent, index: number) {
    if (Date.now() - gestureEnd.current < 350) return;
    const pointerType = (e.nativeEvent as PointerEvent).pointerType;
    // With a mouse or pen, pick mode already toggled the page on pointerdown.
    if (mode === "pick" && pointerType && pointerType !== "touch") return;
    if (mode === "pick" && e.shiftKey) return;
    const page = pages[index];
    const next = new Set(selected);
    if (mode === "pick") {
      if (next.has(page.id)) next.delete(page.id);
      else next.add(page.id);
      anchor.current = page.id;
      onSelectedChange(next);
      return;
    }
    const additive = e.ctrlKey || e.metaKey || ((e.nativeEvent as PointerEvent).pointerType === "touch" && selected.size > 0);
    const a = anchorIndex();
    if (e.shiftKey && a !== null) {
      const lo = Math.min(a, index);
      const hi = Math.max(a, index);
      const range = new Set(additive ? selected : []);
      for (let i = lo; i <= hi; i++) range.add(pages[i].id);
      onSelectedChange(range);
      return;
    }
    if (additive) {
      if (next.has(page.id)) next.delete(page.id);
      else next.add(page.id);
      onSelectedChange(next);
    } else {
      onSelectedChange(new Set([page.id]));
    }
    anchor.current = page.id;
  }

  const items = virtualizer.getVirtualItems();
  const dropPos =
    dropIndex !== null
      ? (() => {
          const row = Math.floor(Math.max(0, dropIndex === pages.length ? pages.length - 1 : dropIndex) / cols);
          const col = dropIndex === pages.length ? ((pages.length - 1) % cols) + 1 : dropIndex % cols;
          return { left: offsetX + col * colW - GAP / 2 - 1, top: PAD + row * rowH };
        })()
      : null;

  return (
    <div
      ref={scrollRef}
      className={`page-grid mode-${mode} ${drag.current?.kind === "reorder" && drag.current.moved ? "reordering" : ""}`}
      tabIndex={0}
      role="listbox"
      aria-label={ariaLabel ?? "Pages"}
      aria-multiselectable="true"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={(e) => {
        const tile = (e.target as HTMLElement).closest<HTMLElement>("[data-page-index]");
        onPageContextMenu?.(tile ? pages[Number(tile.dataset.pageIndex)].id : null);
      }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {items.map((row) => {
          const start = row.index * cols;
          const rowPages = pages.slice(start, start + cols);
          return (
            <div
              key={row.key}
              className="pg-row"
              style={{ transform: `translateY(${row.start}px)`, height: rowH, left: offsetX, gap: GAP }}
            >
              {rowPages.map((page, i) => {
                const index = start + i;
                const isSel = selected.has(page.id);
                const colors = markers?.get(page.id) ?? [];
                const dim = highlight && highlight.size > 0 && !highlight.has(page.id);
                const tags = tagSummary([page], classes);
                return (
                  <div
                    key={page.id}
                    className={`pg-tile ${isSel ? "selected" : ""} ${dim ? "dim" : ""} ${
                      highlight?.has(page.id) ? "lit" : ""
                    }`}
                    style={{ width: tileWidth }}
                    data-page-index={index}
                    role="option"
                    aria-selected={isSel}
                    aria-label={`Page ${labelFor ? labelFor(index, page) : index + 1}${tags ? `, ${tags}` : ""}`}
                    onClick={(e) => onTileClick(e, index)}
                    onDoubleClick={() => (mode === "pick" ? onPreview?.(index) : onOpen?.(index))}
                  >
                    <div className="pg-frame" style={{ height: tileHeight }}>
                      <PageThumb page={page} boxWidth={tileWidth - 12} boxHeight={tileHeight - 12} />
                      {tags && (
                        <PageTags
                          pages={[page]}
                          classes={classes}
                          compact={tileWidth < NAMED_TAGS_MIN}
                          className="pg-tags"
                        />
                      )}
                      {colors.length > 0 && (
                        <div className="pg-markers" aria-hidden="true">
                          {colors.slice(0, 4).map((c, k) => (
                            <span key={k} style={{ background: c }} />
                          ))}
                        </div>
                      )}
                      {mode === "pick" && (
                        <span className={`pg-check ${isSel ? "on" : ""}`} aria-hidden="true">
                          {isSel && <Check size={14} strokeWidth={3} />}
                        </span>
                      )}
                      {onPreview && (
                        <button
                          className="pg-zoom icon-btn icon-btn-sm"
                          aria-label="Enlarge"
                          tabIndex={-1}
                          onClick={(e) => {
                            e.stopPropagation();
                            onPreview(index);
                          }}
                        >
                          <ZoomIn />
                        </button>
                      )}
                    </div>
                    <div className="pg-label tabular">{labelFor ? labelFor(index, page) : index + 1}</div>
                  </div>
                );
              })}
            </div>
          );
        })}
        {dropPos && <div className="pg-drop" style={{ left: dropPos.left, top: dropPos.top, height: tileHeight }} />}
        {marquee && (
          <div
            className="marquee"
            style={{ left: offsetX + marquee.x, top: PAD + marquee.y, width: marquee.w, height: marquee.h }}
          />
        )}
      </div>
    </div>
  );
});

export const ZOOM_STEPS = [96, 128, 168, 220] as const;

/** Zoom level from its stored value; `fallback` when nothing valid is stored. */
export function parseZoomLevel(raw: string | null, fallback: number): number {
  // Number(null) and Number("") are 0, so a missing value must be caught first.
  const saved = raw === null || raw.trim() === "" ? NaN : Number(raw);
  return Number.isInteger(saved) && saved >= 0 && saved < ZOOM_STEPS.length ? saved : fallback;
}

export function useGridZoom(key: string, fallback = 1): [number, (level: number) => void] {
  const storageKey = `academia-zoom-${key}`;
  const [level, setLevel] = useState(() => {
    try {
      return parseZoomLevel(localStorage.getItem(storageKey), fallback);
    } catch {
      return fallback;
    }
  });
  const update = (l: number) => {
    const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, l));
    setLevel(next);
    try {
      localStorage.setItem(storageKey, String(next));
    } catch {
      /* ignore */
    }
  };
  return [level, update];
}
