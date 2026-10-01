import { Dialog } from "radix-ui";
import { Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";
import type { PageRef } from "../../api/types";
import { PageThumb } from "../../components/PageThumb";

/** Large view of one page with previous/next navigation (and optional selection toggle). */
export function PagePreview({
  pages,
  index,
  onIndexChange,
  onClose,
  labelFor,
  selected,
  onToggle,
}: {
  pages: PageRef[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  labelFor: (index: number) => string;
  selected?: Set<string>;
  onToggle?: (pageId: string) => void;
}) {
  // The body sits in a portal that mounts after this component, so measure it once it attaches.
  const [boxEl, setBoxEl] = useState<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 600, h: 800 });
  const page = pages[index];

  useLayoutEffect(() => {
    const el = boxEl;
    if (!el) return;
    const update = () => setBox({ w: el.clientWidth - 24, h: el.clientHeight - 24 });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [boxEl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" && index < pages.length - 1) onIndexChange(index + 1);
      if (e.key === "ArrowLeft" && index > 0) onIndexChange(index - 1);
      // Space/Enter on one of the dialog's buttons presses that button instead.
      if ((e.target as HTMLElement).closest?.("button, input, a")) return;
      if ((e.key === " " || e.key === "Enter") && onToggle) {
        e.preventDefault();
        onToggle(page.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, pages.length, onIndexChange, onToggle, page]);

  if (!page) return null;
  const isSel = selected?.has(page.id);

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="preview-dialog" aria-describedby={undefined}>
          <div className="preview-head">
            <Dialog.Title className="preview-title tabular">{labelFor(index)}</Dialog.Title>
            {onToggle && (
              <button className={`btn btn-sm ${isSel ? "btn-primary" : ""}`} onClick={() => onToggle(page.id)}>
                {isSel ? (
                  <>
                    <Check /> Selected
                  </>
                ) : (
                  "Select page"
                )}
              </button>
            )}
            <Dialog.Close asChild>
              <button className="icon-btn" aria-label="Close">
                <X />
              </button>
            </Dialog.Close>
          </div>
          <div className="preview-body" ref={setBoxEl}>
            <button
              className="preview-nav prev"
              aria-label="Previous page"
              disabled={index === 0}
              onClick={() => onIndexChange(index - 1)}
            >
              <ChevronLeft />
            </button>
            <PageThumb key={page.id} page={page} boxWidth={Math.max(100, box.w)} boxHeight={Math.max(100, box.h)} eager />
            <button
              className="preview-nav next"
              aria-label="Next page"
              disabled={index === pages.length - 1}
              onClick={() => onIndexChange(index + 1)}
            >
              <ChevronRight />
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
