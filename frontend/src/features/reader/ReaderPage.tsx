import { openDocument, pdfjsLib } from "./pdfjs";
import "pdfjs-dist/legacy/web/pdf_viewer.css";
import {
  EventBus,
  LinkTarget,
  PDFLinkService,
  PDFViewer,
  ScrollMode,
  SpreadMode,
} from "pdfjs-dist/legacy/web/pdf_viewer.mjs";

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
import { api, errorMessage, isPageError } from "../../api/client";
import { queryClient, useBookmark, useMe, useNotebook, useProgress } from "../../api/queries";
import type { PageRef, Prefs } from "../../api/types";
import { serverReachable } from "../../components/ConnectionGuard";
import { MenuButton, type MenuEntry } from "../../components/Menu";
import { PageThumb } from "../../components/PageThumb";
import { bookmarkColor } from "../../lib/colors";
import { isEditableTarget, useDocumentTitle, useIsNarrow } from "../../lib/hooks";
import { shortcutKey } from "../../lib/keys";
import { effectiveDark } from "../../lib/theme";
import { pdfErrorMessage, responseStatus, serverRestarting } from "./loadErrors";
import { startPage } from "./position";
import { pageAfterLayoutChange, spreadLabel, spreadModeFor, spreadPages } from "./spreads";
import { reportNetworkError, reportServerUnavailable, useConnection } from "../../state/connection";
import { promptDialog } from "../../state/dialogs";
import { toast, toastError } from "../../state/toasts";

type Layout = Prefs["reader"]["layout"];
type ScrollPref = "page" | "continuous";

const SCROLL_KEY = "academia-reader-scroll";

export default function ReaderPage() {
  const { kind, id } = useParams();
  // Another notebook or bookmark gets a reader of its own: its start page, viewer and state.
  return <Reader key={`${kind}/${id}`} />;
}

function Reader() {
  const { kind, id } = useParams();
  const [params, setParams] = useSearchParams();
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
  // Nothing in the Trash can be read (its PDF is a 404) until it is restored.
  const inTrash = !!(isBookmark ? bm?.trashed_at : nb?.trashed_at);
  const unavailable = !!(isBookmark && bm && !bm.available);

  // Pinned to the PDF's digest: pdf.js keeps fetching byte ranges from this URL, and the
  // server answers 409 instead of serving parts of a different PDF once it has changed.
  const pdfUrl = useMemo(() => {
    if (inTrash || unavailable) return null;
    const doc = isBookmark ? bm : nb;
    if (!doc) return null;
    const base = `/api/${isBookmark ? "bookmarks" : "notebooks"}/${doc.id}/pdf`;
    return doc.pdf_digest ? `${base}?d=${doc.pdf_digest}` : base;
  }, [isBookmark, bm, nb, inTrash, unavailable]);

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
  const initialScale = useRef("page-fit");
  // The pages of the document in the viewer, which its page numbers (`current`) count. `pages`
  // moves on to a new revision as soon as it is fetched, while its PDF is still loading.
  const shownPages = useRef<PageRef[]>([]);
  // The page the reader went to, which a two-page spread shows but does not make current.
  const keptPage = useRef<number | null>(null);
  // The zoom that fits the page, to return to when a pinch zooms out past it.
  const fitZoom = useRef({ value: "page-fit", scale: 0 });
  const touchStart = useRef<{ x: number; y: number; t: number; multi: boolean } | null>(null);
  const lastAutoReload = useRef(0);
  // A request for the document failed while the server was out of reach: load it again once back.
  const reloadWhenOnline = useRef(false);
  const [reloadKey, setReloadKey] = useState(0);
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

  // Bookmark pages are numbered as in their notebook.
  const numberFor = useCallback((n: number) => (isBookmark && pages[n - 1]?.number) || n, [pages, isBookmark]);
  const labelFor = useCallback((n: number) => String(numberFor(n)), [numberFor]);

  const applyLayout = useCallback(() => {
    const viewer = viewerRef.current;
    const stage = stageRef.current;
    if (!viewer || !stage || !viewer.pagesCount) return; // pdf.js lays out pages only once they exist
    const s = settingsRef.current;
    const mode = spreadModeFor(s.layout, s.coverAlone, stage.clientWidth, stage.clientHeight);
    const scroll = s.scrollPref === "page" ? ScrollMode.PAGE : ScrollMode.VERTICAL;
    // pdf.js marks only the horizontal and wrapped modes; the page mode styles need a class too.
    viewer.viewer?.classList.toggle("scrollPage", scroll === ScrollMode.PAGE);
    if (viewer.scrollMode !== scroll) viewer.scrollMode = scroll;
    if (viewer.spreadMode !== mode) {
      // Going from one page to two and back must not leave the reader a page back.
      const page = pageAfterLayoutChange(viewer.currentPageNumber, viewer.pagesCount, viewer.spreadMode, keptPage.current);
      viewer.spreadMode = mode;
      keptPage.current = page;
      if (viewer.currentPageNumber !== page) viewer.currentPageNumber = page;
    }
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
    // Aborting it removes the listeners and observers the viewer adds outside its pages.
    const teardown = new AbortController();
    const viewer = new PDFViewer({
      container,
      eventBus,
      linkService,
      textLayerMode: 1,
      annotationMode: 2,
      // The reader never edits annotations; the editor would add listeners to window and document.
      annotationEditorMode: pdfjsLib.AnnotationEditorType.DISABLE,
      removePageBorders: false,
      abortSignal: teardown.signal,
    } as ConstructorParameters<typeof PDFViewer>[0]); // pdf.js's typings lack `abortSignal`
    linkService.setViewer(viewer);
    viewerRef.current = viewer;
    eventBusRef.current = eventBus;

    // pdf.js fits a preset zoom ("Fit page") to the page shown when it is applied and keeps that
    // scale for every page: fit each page (or spread) again once it is shown and its size known.
    let refitFrame = 0;
    const refit = () => {
      refitFrame = 0;
      const value = viewer.currentScaleValue;
      if (viewer.scrollMode !== ScrollMode.PAGE || !viewer.pagesCount) return;
      if (value === "page-fit" || value === "page-width" || value === "auto") viewer.currentScaleValue = value;
    };
    const scheduleRefit = () => {
      refitFrame ||= requestAnimationFrame(refit);
    };

    eventBus.on("pagesinit", () => {
      viewer.currentScaleValue = initialScale.current;
      applyLayout();
      if (initialPage.current) viewer.currentPageNumber = initialPage.current;
      keptPage.current = initialPage.current;
      setCurrent(viewer.currentPageNumber);
      setLoading(false);
    });
    eventBus.on("pagechanging", ({ pageNumber }: { pageNumber: number }) => {
      setCurrent(pageNumber);
      scheduleRefit();
    });
    eventBus.on("pagerender", ({ pageNumber }: { pageNumber: number }) => {
      if (pageNumber === viewer.currentPageNumber) scheduleRefit();
    });
    eventBus.on("scalechanging", ({ presetValue, scale }: { presetValue?: string; scale: number }) => {
      if (presetValue === "page-fit" || presetValue === "auto") fitZoom.current = { value: presetValue, scale };
      setScaleLabel(presetValue ?? String(scale));
    });

    // Pinch to zoom: pdf.js renders the pages again at the new zoom, where the browser's own
    // pinch would only magnify them (and turn pages, taken for a swipe).
    let pinchStart = 0;
    let pinchFactor = 1;
    const touchManager = new pdfjsLib.TouchManager({
      container,
      isPinchingDisabled: () => !viewer.pagesCount,
      onPinchStart: () => {
        if (touchStart.current) touchStart.current.multi = true;
        pinchStart = viewer.currentScale;
        pinchFactor = 1;
      },
      onPinching: (origin: [number, number], prevDistance: number, distance: number, dx: number, dy: number) => {
        if (!pinchStart) return;
        const scale = Math.min(Math.max(pinchStart * pinchFactor * (distance / prevDistance), 0.25), 10);
        pinchFactor = scale / pinchStart;
        viewer.updateScale({ drawingDelay: 400, scaleFactor: scale / viewer.currentScale, origin, pan: [dx, dy] });
      },
      onPanning: (dx: number, dy: number) => viewer.panBy(dx, dy),
      onPinchEnd: () => {
        // Zoomed out to about the fit or past it: fit again, which turns pages by swipe again.
        const fit = fitZoom.current;
        if (fit.scale && viewer.currentScale <= fit.scale * 1.05) viewer.currentScaleValue = fit.value;
      },
      signal: teardown.signal,
    });
    return () => {
      cancelAnimationFrame(refitFrame);
      touchManager.destroy();
      // pdf.js keeps the viewer, with every page canvas it rendered, reachable from window and
      // document listeners until its document is unset. Destroying the rendered pages first
      // frees their canvases at once (Safari caps the memory all canvases may use).
      for (const pageView of viewer.getCachedPageViews()) pageView.destroy();
      viewer.setDocument(null as never); // pdf.js's typings lack null, which unsets the document
      linkService.setDocument(null);
      teardown.abort();
      viewerRef.current = null;
      eventBusRef.current = null;
    };
  }, [applyLayout]);

  // Load (or reload) the document.
  const progressReady = !progressQuery.isLoading;
  useEffect(() => {
    if (!pdfUrl || !progressReady || !pages.length) return;
    const viewer = viewerRef.current;
    const eventBus = eventBusRef.current;
    if (!viewer || !eventBus) return;
    if (initialPage.current === null) {
      initialPage.current = startPage(params.get("page"), pages, progressQuery.data);
      // `?page=` only says where to open: a reload, or coming back here, resumes from the
      // saved position instead.
      if (params.has("page"))
        setParams(
          (p) => {
            const next = new URLSearchParams(p);
            next.delete("page");
            return next;
          },
          { replace: true },
        );
    } else if (viewer.pagesCount) {
      // Reloading: stay on the same page (wherever a new revision moved it), at the same zoom.
      const n = pageAfterLayoutChange(viewer.currentPageNumber, viewer.pagesCount, viewer.spreadMode, keptPage.current);
      initialPage.current = startPage(null, pages, { page_id: shownPages.current[n - 1]?.id ?? null, page_index: n - 1 });
      initialScale.current = viewer.currentScaleValue || "page-fit";
    }
    let cancelled = false;
    let failed = false;
    reloadWhenOnline.current = false;
    setLoading(true);
    setError(null);
    const task = openDocument(pdfUrl);
    const refetchItem = () => queryClient.invalidateQueries({ queryKey: [isBookmark ? "bookmark" : "notebook", id] });

    // pdf.js never retries a byte range that failed to download, so every page that needs it
    // stays blank for as long as this document is open: load the document again instead.
    const onPageFailure = (err: unknown) => {
      if (cancelled || failed) return;
      failed = true;
      const status = responseStatus(err);
      if (status === 404 || status === 409) {
        // Changed (a new revision) or moved to the Trash elsewhere: the refetch shows which.
        void refetchItem();
      } else if (serverRestarting(status)) {
        reloadWhenOnline.current = true;
        reportServerUnavailable();
      } else if (useConnection.getState().status !== "online") {
        reloadWhenOnline.current = true;
      } else if (Date.now() - lastAutoReload.current > 60_000) {
        lastAutoReload.current = Date.now();
        setReloadKey((k) => k + 1);
      } else {
        // It failed again right after a reload, so it may not be the connection: let the reader decide.
        toast("Some pages couldn't be loaded.", {
          kind: "error",
          action: { label: "Reload", onClick: () => setReloadKey((k) => k + 1) },
        });
      }
    };
    const onPageRendered = (evt: { source: unknown; pageNumber: number; error: unknown }) => {
      if (evt.error && evt.source === viewer.getPageView(evt.pageNumber - 1)) onPageFailure(evt.error);
    };

    task.promise
      .then(async (doc) => {
        await doc.getPage(1); // the viewer lays out every page from the first one
        return doc;
      })
      .then(
        (doc) => {
          if (cancelled) return;
          // The viewer only logs a page that fails to load.
          const getPage = doc.getPage.bind(doc);
          doc.getPage = (n) =>
            getPage(n).catch((err: unknown) => {
              onPageFailure(err);
              throw err;
            });
          viewer.setDocument(doc);
          shownPages.current = pages;
          (viewer.linkService as PDFLinkService).setDocument(doc, null);
          eventBus.on("pagerendered", onPageRendered);
          setNumPages(doc.numPages);
        },
        async (err: unknown) => {
          if (cancelled) return;
          const status = responseStatus(err);
          if (status === 409) {
            // The notebook changed since we loaded it; refresh and retry with the new revision.
            await refetchItem();
            return;
          }
          if (status === 404) void refetchItem(); // shows whether it was moved to the Trash
          const reach = serverRestarting(status) ? "down" : status ? "ok" : await serverReachable();
          if (cancelled) return;
          if (reach !== "ok") {
            // The connection overlay explains; the document reloads once the server is back.
            reloadWhenOnline.current = true;
            if (reach === "offline") reportNetworkError();
            else reportServerUnavailable();
            return;
          }
          setError(pdfErrorMessage(err));
          setLoading(false);
        },
      );
    return () => {
      cancelled = true;
      eventBus.off("pagerendered", onPageRendered);
      void task.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfUrl, progressReady, reloadKey]);

  // pdf.js won't retry the requests that failed while the connection was down: reload the
  // document once it is back (only then: a reload shows the spinner and refetches the pages).
  useEffect(
    () =>
      useConnection.subscribe((state, previous) => {
        if (state.status !== "online" || previous.status === "online" || !reloadWhenOnline.current) return;
        reloadWhenOnline.current = false;
        setReloadKey((k) => k + 1);
      }),
    [],
  );

  // Re-apply layout when preferences change or the window resizes.
  useEffect(() => applyLayout(), [layout, coverAlone, scrollPref, applyLayout]);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const ro = new ResizeObserver(() => applyLayout());
    ro.observe(stage);
    return () => ro.disconnect();
  }, [applyLayout, sidebar]);

  // Save reading position: the page on screen.
  const pendingSave = useRef<(() => void) | null>(null);
  useEffect(() => {
    const shown = shownPages.current;
    if (!id || loading || !shown[current - 1]) return;
    const json = { page_id: shown[current - 1].id, page_index: current - 1 };
    let saved = false;
    const save = (keepalive = false) => {
      if (saved) return;
      saved = true;
      pendingSave.current = null;
      api(`/progress/${id}`, { method: "PUT", json, keepalive }).catch(() => undefined);
    };
    pendingSave.current = () => save(true);
    const t = setTimeout(save, 800);
    return () => clearTimeout(t);
  }, [current, id, loading]);
  // A page turned just before leaving the reader, or the app, is saved too.
  useEffect(() => {
    const flush = () => pendingSave.current?.();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const go = useCallback((n: number) => {
    const viewer = viewerRef.current;
    if (!viewer || !Number.isInteger(n) || n < 1 || n > viewer.pagesCount) return; // pdf.js throws on n = 2.5
    viewer.currentPageNumber = n;
    keptPage.current = n;
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
      else if (shortcutKey(e) === "f") toggleFullscreen();
      else if (k === "Escape") setSidebar(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  // Click the outer edges of the page area to turn pages; swipe on touch screens.
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
    updatePrefs({ reader: patch }).catch(toastError);

  const visible = spreadPages(current, numPages, spread);
  const indicator = spreadLabel((visible.length ? visible : [current]).map(numberFor));

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
    // The pages on screen.
    const ids = visible.map((n) => shownPages.current[n - 1]?.id).filter(Boolean) as string[];
    if (!nb || !ids.length) return;
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

  // A failed background refetch keeps the document that is already open.
  const loadError = [nbQuery, bmQuery].find((q) => isPageError(q.error, !!q.data))?.error;
  const empty = !!(nb || bm) && pages.length === 0;
  const canRead = !inTrash && !unavailable && !empty;
  const retry = () => {
    if (loadError) void (isBookmark ? bmQuery : nbQuery).refetch();
    setReloadKey((k) => k + 1);
  };
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
        {!isBookmark && nb && !inTrash && !narrow && (
          <button className="icon-btn" aria-label="Bookmark these pages" title="Bookmark these pages" onClick={() => void bookmarkSpread()}>
            <BookmarkPlus />
          </button>
        )}
        <button
          className="icon-btn"
          aria-label="Download PDF"
          title="Download PDF"
          disabled={!pages.length || inTrash || unavailable}
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
            if (e.touches.length > 1) {
              if (touchStart.current) touchStart.current.multi = true;
              return;
            }
            const t = e.touches[0];
            touchStart.current = { x: t.clientX, y: t.clientY, t: Date.now(), multi: false };
          }}
          onTouchMove={(e) => {
            if (e.touches.length > 1 && touchStart.current) touchStart.current.multi = true;
          }}
          onTouchEnd={(e) => {
            const s = touchStart.current;
            // A finger lifted while another stays down ends a pinch, which is never a swipe.
            if (e.touches.length) {
              if (s) s.multi = true;
              return;
            }
            touchStart.current = null;
            if (!s || s.multi || (window.visualViewport?.scale ?? 1) > 1.01) return; // the browser is zoomed in
            if (scrollPref !== "page" || !fitted || e.changedTouches.length !== 1) return;
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
          {(loading || !pdfUrl) && !error && !loadError && canRead && (
            <div className="reader-overlay">
              <div className="spinner lg" />
            </div>
          )}
          {(error || loadError || !canRead) && (
            <div className="reader-overlay">
              <div className="overlay-card">
                <h2>
                  {inTrash
                    ? `${isBookmark ? "Bookmark" : "Notebook"} in Trash`
                    : unavailable
                      ? "Notebook in Trash"
                      : empty
                        ? "Nothing to read yet"
                        : "Couldn't open this PDF"}
                </h2>
                <p>
                  {inTrash
                    ? `This ${isBookmark ? "bookmark" : "notebook"} is in the Trash. Restore it to read it.`
                    : unavailable
                      ? "This bookmark's notebook is in the Trash. Restore it to read this bookmark."
                      : empty
                        ? isBookmark
                          ? "This bookmark has no pages selected."
                          : "This notebook has no pages yet."
                        : error || errorMessage(loadError)}
                </p>
                <div className="overlay-actions">
                  <button className={canRead ? "btn" : "btn btn-primary"} onClick={() => navigate(backTo)}>
                    Go back
                  </button>
                  {canRead && (
                    <button className="btn btn-primary" onClick={retry}>
                      Try again
                    </button>
                  )}
                </div>
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
          {isBookmark ? (visible.length > 1 ? "pp. " : "p. ") : "Page "}
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
            if (Number.isInteger(target) && target >= 1 && target <= numPages) go(target);
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
