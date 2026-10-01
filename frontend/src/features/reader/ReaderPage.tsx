import { openDocument } from "./pdfjs";
import "pdfjs-dist/web/pdf_viewer.css";
import { EventBus, LinkTarget, PDFLinkService, PDFViewer, ScrollMode, SpreadMode } from "pdfjs-dist/web/pdf_viewer.mjs";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import {
  ArrowLeft,
  BookmarkPlus,
  Columns2,
  Download,
  Maximize,
  Minimize,
  PanelLeft,
  RectangleVertical,
  ZoomIn,
  ZoomOut,
  ChevronLeft,
  ChevronRight,
  Scan,
} from "lucide-react";
import { createBookmark, downloadNode, updatePrefs } from "../../api/actions";
import { api, errorMessage } from "../../api/client";
import { queryClient, useBookmark, useMe, useNotebook, useProgress } from "../../api/queries";
import type { PageRef, Prefs } from "../../api/types";
import { MenuButton, type MenuEntry } from "../../components/Menu";
import { PageThumb } from "../../components/PageThumb";
import { bookmarkColor } from "../../lib/colors";
import { isEditableTarget, useDocumentTitle, useIsNarrow } from "../../lib/hooks";
import { effectiveDark } from "../../lib/theme";
import { spreadModeFor, spreadPages } from "./spreads";
import { promptDialog } from "../../state/dialogs";
import { toast, toastError } from "../../state/toasts";

type Layout = Prefs["reader"]["layout"];
type ScrollPref = "page" | "continuous";

const SCROLL_KEY = "academia-reader-scroll";

export default function ReaderPage() {
  const { kind, id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const narrow = useIsNarrow();
  const isBookmark = kind === "b";
  const { data: me } = useMe();
  const nbQuery = useNotebook(isBookmark ? undefined : id);
  const bmQuery = useBookmark(isBookmark ? id : undefined);
  const progressQuery = useProgress(id);
  const nb = nbQuery.data;
  const bm = bmQuery.data;

  const pages: (PageRef & { number?: number })[] = useMemo(
    () => (isBookmark ? (bm?.pages ?? []) : (nb?.pages ?? [])),
    [isBookmark, bm?.pages, nb?.pages],
  );
  const title = isBookmark ? bm?.name : nb?.name;
  useDocumentTitle(title);

  const pdfUrl = useMemo(() => {
    if (isBookmark) return bm ? `/api/bookmarks/${bm.id}/pdf?v=${bm.rev}-${bm.notebook.rev}` : null;
    return nb ? `/api/notebooks/${nb.id}/pdf?rev=${nb.rev}` : null;
  }, [isBookmark, bm, nb]);

  const layout: Layout = me?.prefs.reader.layout ?? "auto";
  const coverAlone = me?.prefs.reader.cover_alone ?? false;
  const [scrollPref, setScrollPref] = useState<ScrollPref>(
    () => (localStorage.getItem(SCROLL_KEY) as ScrollPref) || "page",
  );

  const stageRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PDFViewer | null>(null);
  const eventBusRef = useRef<EventBus | null>(null);
  const initialPage = useRef<number | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [current, setCurrent] = useState(1);
  const [spread, setSpread] = useState<number>(SpreadMode.NONE);
  const [scaleLabel, setScaleLabel] = useState("page-fit");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sidebar, setSidebar] = useState<null | "pages" | "bookmarks">(null);
  const [fullscreen, setFullscreen] = useState(false);
  const settingsRef = useRef({ layout, coverAlone, scrollPref });
  settingsRef.current = { layout, coverAlone, scrollPref };

  const labelFor = useCallback(
    (n: number) => {
      const page = pages[n - 1];
      if (!page) return String(n);
      return isBookmark && page.number ? String(page.number) : String(n);
    },
    [pages, isBookmark],
  );

  const applyLayout = useCallback(() => {
    const viewer = viewerRef.current;
    const stage = stageRef.current;
    if (!viewer || !stage || !viewer.pdfDocument) return;
    const s = settingsRef.current;
    const mode = spreadModeFor(s.layout, s.coverAlone, stage.clientWidth, stage.clientHeight);
    const scroll = s.scrollPref === "page" ? ScrollMode.PAGE : ScrollMode.VERTICAL;
    if (viewer.scrollMode !== scroll) viewer.scrollMode = scroll;
    if (viewer.spreadMode !== mode) viewer.spreadMode = mode;
    setSpread(mode);
    const value = viewer.currentScaleValue;
    if (value === "page-fit" || value === "page-width" || value === "auto") viewer.currentScaleValue = value;
  }, []);

  // Create the viewer once.
  useEffect(() => {
    const container = containerRef.current!;
    const eventBus = new EventBus();
    // Links inside PDFs open in a new tab so they never navigate away from the reader.
    const linkService = new PDFLinkService({
      eventBus,
      externalLinkTarget: LinkTarget.BLANK,
      externalLinkRel: "noopener noreferrer nofollow",
    });
    const viewer = new PDFViewer({
      container,
      eventBus,
      linkService,
      textLayerMode: 1,
      annotationMode: 2,
      removePageBorders: false,
      supportsPinchToZoom: true,
    });
    linkService.setViewer(viewer);
    viewerRef.current = viewer;
    eventBusRef.current = eventBus;

    eventBus.on("pagesinit", () => {
      viewer.currentScaleValue = "page-fit";
      applyLayout();
      if (initialPage.current) viewer.currentPageNumber = initialPage.current;
      setLoading(false);
    });
    eventBus.on("pagechanging", ({ pageNumber }: { pageNumber: number }) => setCurrent(pageNumber));
    eventBus.on("scalechanging", ({ presetValue, scale }: { presetValue?: string; scale: number }) =>
      setScaleLabel(presetValue ?? String(scale)),
    );
    return () => {
      viewerRef.current = null;
      eventBusRef.current = null;
    };
  }, [applyLayout]);

  // Load (or reload) the document.
  const progressReady = !progressQuery.isLoading;
  useEffect(() => {
    if (!pdfUrl || !progressReady || !pages.length) return;
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (initialPage.current === null) {
      const fromQuery = Number(params.get("page"));
      const saved = progressQuery.data?.page_id ? pages.findIndex((p) => p.id === progressQuery.data?.page_id) : -1;
      initialPage.current = fromQuery >= 1 ? Math.min(fromQuery, pages.length) : saved >= 0 ? saved + 1 : 1;
    } else {
      initialPage.current = viewer.currentPageNumber || initialPage.current;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const task = openDocument(pdfUrl);
    task.promise.then(
      (doc) => {
        if (cancelled) return;
        viewer.setDocument(doc);
        (viewer.linkService as PDFLinkService).setDocument(doc, null);
        setNumPages(doc.numPages);
      },
      async (err: { status?: number; message?: string }) => {
        if (cancelled) return;
        if (err?.status === 409) {
          // The notebook changed since we loaded it; refresh and retry with the new revision.
          await queryClient.invalidateQueries({ queryKey: [isBookmark ? "bookmark" : "notebook", id] });
          return;
        }
        setError(err?.message || "The PDF could not be loaded.");
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
      void task.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfUrl, progressReady]);

  // Re-apply layout when preferences change or the window resizes.
  useEffect(() => applyLayout(), [layout, coverAlone, scrollPref, applyLayout]);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const ro = new ResizeObserver(() => applyLayout());
    ro.observe(stage);
    return () => ro.disconnect();
  }, [applyLayout, sidebar]);

  // Save reading position.
  useEffect(() => {
    if (!id || loading || !pages[current - 1]) return;
    const t = setTimeout(() => {
      api(`/progress/${id}`, {
        method: "PUT",
        json: { page_id: pages[current - 1].id, page_index: current - 1 },
      }).catch(() => undefined);
    }, 800);
    return () => clearTimeout(t);
  }, [current, id, pages, loading]);

  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const go = useCallback((n: number) => {
    const viewer = viewerRef.current;
    if (viewer && n >= 1 && n <= viewer.pagesCount) viewer.currentPageNumber = n;
  }, []);
  const next = () => viewerRef.current?.nextPage();
  const prev = () => viewerRef.current?.previousPage();
  const setScale = (value: string) => {
    if (viewerRef.current) viewerRef.current.currentScaleValue = value;
  };
  const zoomIn = () => viewerRef.current?.increaseScale();
  const zoomOut = () => viewerRef.current?.decreaseScale();
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => undefined);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target) || document.querySelector(".modal, .menu, .preview-dialog")) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      if (k === "ArrowRight" || k === "PageDown" || (k === " " && !e.shiftKey)) {
        if (settingsRef.current.scrollPref === "continuous" && k === " ") return;
        e.preventDefault();
        viewerRef.current?.nextPage();
      } else if (k === "ArrowLeft" || k === "PageUp" || (k === " " && e.shiftKey)) {
        e.preventDefault();
        viewerRef.current?.previousPage();
      } else if (k === "Home") {
        e.preventDefault();
        go(1);
      } else if (k === "End") {
        e.preventDefault();
        go(viewerRef.current?.pagesCount ?? 1);
      } else if (k === "+" || k === "=") viewerRef.current?.increaseScale();
      else if (k === "-") viewerRef.current?.decreaseScale();
      else if (k === "0") setScale("page-fit");
      else if (k === "f") toggleFullscreen();
      else if (k === "Escape") setSidebar(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  // Click the outer edges of the page area to turn pages; swipe on touch screens.
  const touchStart = useRef<{ x: number; y: number; t: number } | null>(null);
  const fitted = scaleLabel === "page-fit" || scaleLabel === "auto";
  function onStageClick(e: React.MouseEvent) {
    if (scrollPref !== "page" || !fitted) return;
    if ((e.target as HTMLElement).closest("a, button, input, .annotationLayer section")) return;
    if (window.getSelection()?.toString()) return;
    const box = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - box.left) / box.width;
    if (x < 0.2) prev();
    else if (x > 0.8) next();
  }

  const setReaderPref = (patch: Partial<Prefs["reader"]>) =>
    updatePrefs({ reader: { ...(me?.prefs.reader ?? { layout: "auto", cover_alone: false }), ...patch } }).catch(toastError);

  const visible = spreadPages(current, numPages, spread);
  const indicator =
    visible.length > 1 ? `${labelFor(visible[0])}–${labelFor(visible[1])}` : labelFor(visible[0] ?? current);

  const layoutEntries: MenuEntry[] = [
    { type: "label", label: "Pages" },
    { label: "Automatic", checked: layout === "auto", onSelect: () => void setReaderPref({ layout: "auto" }) },
    { label: "One page", checked: layout === "single", onSelect: () => void setReaderPref({ layout: "single" }) },
    { label: "Two pages side by side", checked: layout === "double", onSelect: () => void setReaderPref({ layout: "double" }) },
    { type: "sep" },
    { label: "Show first page alone", checked: coverAlone, onSelect: () => void setReaderPref({ cover_alone: !coverAlone }) },
    {
      label: "Continuous scrolling",
      checked: scrollPref === "continuous",
      onSelect: () => {
        const nextPref = scrollPref === "page" ? "continuous" : "page";
        localStorage.setItem(SCROLL_KEY, nextPref);
        setScrollPref(nextPref);
      },
    },
  ];

  const zoomEntries: MenuEntry[] = [
    { label: "Fit page", checked: scaleLabel === "page-fit", onSelect: () => setScale("page-fit") },
    { label: "Fit width", checked: scaleLabel === "page-width", onSelect: () => setScale("page-width") },
    { label: "Actual size", checked: scaleLabel === "page-actual", onSelect: () => setScale("page-actual") },
  ];

  const bookmarkSpread = async () => {
    if (!nb) return;
    const ids = visible.map((n) => pages[n - 1]?.id).filter(Boolean) as string[];
    const name = await promptDialog({
      title: "Bookmark these pages",
      message: `Pages ${indicator} of “${nb.name}”. The bookmark is saved next to the notebook.`,
      label: "Name",
      initial: `Page ${indicator}`,
      confirmLabel: "Create bookmark",
    });
    if (!name) return;
    try {
      await createBookmark(nb.parent_id, name, nb.id, ids);
      toast(`Bookmark “${name}” created.`);
    } catch (err) {
      toastError(err);
    }
  };

  const loadError = nbQuery.error || bmQuery.error;
  const unavailable = isBookmark && bm && !bm.available;
  const empty = !!(nb || bm) && pages.length === 0;
  const backTo = isBookmark ? (bm?.parent_id ? `/f/${bm.parent_id}` : "/") : nb ? `/n/${nb.id}` : "/";
  const dark = effectiveDark();

  return (
    <div className={`reader ${fullscreen ? "is-fullscreen" : ""}`}>
      <header className="reader-bar">
        <button
          className="icon-btn"
          aria-label="Back"
          title="Back"
          onClick={() => (window.history.length > 1 ? navigate(-1) : navigate(backTo))}
        >
          <ArrowLeft />
        </button>
        <div className="reader-title">
          <strong className="truncate">{title ?? "…"}</strong>
          {!narrow && (
            <span className="truncate faint">
              {isBookmark ? (
                bm ? (
                  <>
                    Bookmark in <Link to={`/n/${bm.notebook.id}`}>{bm.notebook.name}</Link> · {bm.label}
                  </>
                ) : null
              ) : (
                "Notebook"
              )}
            </span>
          )}
        </div>
        <button
          className="icon-btn"
          aria-label="Contents"
          title="Pages and bookmarks"
          aria-pressed={!!sidebar}
          onClick={() => setSidebar(sidebar ? null : "pages")}
        >
          <PanelLeft />
        </button>
        <MenuButton entries={layoutEntries} label="Page layout">
          {spread === SpreadMode.NONE ? <RectangleVertical /> : <Columns2 />}
        </MenuButton>
        {!narrow && (
          <>
            <button className="icon-btn" aria-label="Zoom out" title="Zoom out (−)" onClick={zoomOut}>
              <ZoomOut />
            </button>
            <MenuButton entries={zoomEntries} label="Zoom" className="btn btn-ghost btn-sm zoom-btn">
              <Scan size={15} />
              {scaleLabel === "page-fit" ? "Fit" : scaleLabel === "page-width" ? "Width" : `${Math.round(Number(scaleLabel) * 100) || 100}%`}
            </MenuButton>
            <button className="icon-btn" aria-label="Zoom in" title="Zoom in (+)" onClick={zoomIn}>
              <ZoomIn />
            </button>
          </>
        )}
        {!isBookmark && nb && !narrow && (
          <button className="icon-btn" aria-label="Bookmark these pages" title="Bookmark these pages" onClick={() => void bookmarkSpread()}>
            <BookmarkPlus />
          </button>
        )}
        <button
          className="icon-btn"
          aria-label="Download PDF"
          title="Download PDF"
          disabled={!pages.length}
          onClick={() => downloadNode({ id: id!, kind: isBookmark ? "bookmark" : "notebook" })}
        >
          <Download />
        </button>
        {document.fullscreenEnabled && (
          <button className="icon-btn" aria-label="Full screen" title="Full screen (f)" onClick={toggleFullscreen}>
            {fullscreen ? <Minimize /> : <Maximize />}
          </button>
        )}
      </header>

      <div className="reader-body">
        {sidebar && (
          <ReaderSidebar
            tab={sidebar}
            onTab={setSidebar}
            pages={pages}
            current={current}
            visible={visible}
            labelFor={labelFor}
            onGo={(n) => {
              go(n);
              if (narrow) setSidebar(null);
            }}
            bookmarks={
              isBookmark
                ? (bm?.segments ?? []).map(([a, b], i) => {
                    const start = pages.findIndex((p) => p.number === a) + 1;
                    return { id: `seg-${i}`, name: a === b ? `Page ${a}` : `Pages ${a}–${b}`, label: "", page: start, color: "var(--accent)" };
                  })
                : (nb?.bookmarks ?? [])
                    .filter((b) => b.first_position !== null)
                    .map((b) => ({
                      id: b.id,
                      name: b.name,
                      label: b.label,
                      page: (b.first_position ?? 0) + 1,
                      color: bookmarkColor(b.id),
                    }))
            }
            bookmarksTitle={isBookmark ? "Sections" : "Bookmarks"}
          />
        )}
        <div
          className={`reader-stage ${dark ? "dim-pages" : ""}`}
          ref={stageRef}
          onClick={onStageClick}
          onTouchStart={(e) => {
            const t = e.touches[0];
            touchStart.current = { x: t.clientX, y: t.clientY, t: Date.now() };
          }}
          onTouchEnd={(e) => {
            const s = touchStart.current;
            touchStart.current = null;
            if (!s || scrollPref !== "page" || !fitted || e.changedTouches.length !== 1) return;
            const t = e.changedTouches[0];
            const dx = t.clientX - s.x;
            const dy = t.clientY - s.y;
            if (Math.abs(dx) > 60 && Math.abs(dy) < 60 && Date.now() - s.t < 600) {
              if (dx < 0) next();
              else prev();
            }
          }}
        >
          <div ref={containerRef} className="reader-container">
            <div className="pdfViewer" />
          </div>
          {(loading || !pdfUrl) && !error && !loadError && !unavailable && !empty && (
            <div className="reader-overlay">
              <div className="spinner lg" />
            </div>
          )}
          {(error || loadError || unavailable || empty) && (
            <div className="reader-overlay">
              <div className="overlay-card">
                <h2>
                  {unavailable ? "Notebook in Trash" : empty ? "Nothing to read yet" : "Couldn't open this PDF"}
                </h2>
                <p>
                  {unavailable
                    ? "This bookmark's notebook is in the Trash. Restore it to read this bookmark."
                    : empty
                      ? isBookmark
                        ? "This bookmark has no pages selected."
                        : "This notebook has no pages yet."
                      : error || errorMessage(loadError)}
                </p>
                <button className="btn btn-primary" onClick={() => navigate(backTo)}>
                  Go back
                </button>
              </div>
            </div>
          )}
          {!narrow && scrollPref === "page" && numPages > 1 && (
            <>
              <button className="page-turn prev" aria-label="Previous page" onClick={prev} disabled={current <= 1}>
                <ChevronLeft />
              </button>
              <button
                className="page-turn next"
                aria-label="Next page"
                onClick={next}
                disabled={visible[visible.length - 1] >= numPages}
              >
                <ChevronRight />
              </button>
            </>
          )}
        </div>
      </div>

      <footer className="reader-foot">
        <span className="page-indicator tabular">
          {isBookmark ? "p. " : "Page "}
          {indicator}
          <span className="faint">
            {" "}
            {isBookmark ? `(${visible[0] ?? current} of ${numPages || pages.length})` : `of ${numPages || pages.length}`}
          </span>
        </span>
        <input
          className="scrubber"
          type="range"
          min={1}
          max={Math.max(1, numPages)}
          value={current}
          onChange={(e) => go(Number(e.target.value))}
          aria-label="Page"
          aria-valuetext={`Page ${labelFor(current)}`}
        />
        <button
          className="btn btn-sm btn-ghost tabular"
          onClick={async () => {
            const value = await promptDialog({
              title: "Go to page",
              label: isBookmark ? "Page (number in the notebook)" : `Page (1–${numPages})`,
              initial: labelFor(current),
              confirmLabel: "Go",
            });
            if (!value) return;
            const n = Number(value);
            const target = isBookmark ? pages.findIndex((p) => p.number === n) + 1 : n;
            if (target >= 1 && target <= numPages) go(target);
            else toast("That page isn't in this " + (isBookmark ? "bookmark." : "notebook."));
          }}
        >
          Go to…
        </button>
      </footer>
    </div>
  );
}

function ReaderSidebar({
  tab,
  onTab,
  pages,
  current,
  visible,
  labelFor,
  onGo,
  bookmarks,
  bookmarksTitle,
}: {
  tab: "pages" | "bookmarks";
  onTab: (tab: "pages" | "bookmarks" | null) => void;
  pages: PageRef[];
  current: number;
  visible: number[];
  labelFor: (n: number) => string;
  onGo: (n: number) => void;
  bookmarks: { id: string; name: string; label: string; page: number; color: string }[];
  bookmarksTitle: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (tab !== "pages") return;
    listRef.current?.querySelector(`[data-n="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current, tab]);
  return (
    <aside className="reader-side" aria-label="Contents">
      <div className="segmented reader-tabs" role="tablist">
        <button role="tab" aria-pressed={tab === "pages"} aria-selected={tab === "pages"} onClick={() => onTab("pages")}>
          Pages
        </button>
        <button
          role="tab"
          aria-pressed={tab === "bookmarks"}
          aria-selected={tab === "bookmarks"}
          onClick={() => onTab("bookmarks")}
        >
          {bookmarksTitle}
        </button>
      </div>
      {tab === "pages" ? (
        <div className="reader-thumbs" ref={listRef}>
          {pages.map((page, i) => (
            <button
              key={page.id}
              data-n={i + 1}
              className={`reader-thumb ${visible.includes(i + 1) ? "current" : ""}`}
              onClick={() => onGo(i + 1)}
            >
              <PageThumb page={page} boxWidth={120} boxHeight={150} />
              <span className="tabular">{labelFor(i + 1)}</span>
            </button>
          ))}
        </div>
      ) : (
        <ul className="reader-marks">
          {bookmarks.length === 0 && <li className="muted panel-empty">No bookmarks in this notebook.</li>}
          {bookmarks.map((b) => (
            <li key={b.id}>
              <button onClick={() => onGo(b.page)}>
                <span className="bm-swatch" style={{ background: b.color }} />
                <span className="bm-text">
                  <span className="truncate">{b.name}</span>
                  {b.label && <small className="tabular">{b.label}</small>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
