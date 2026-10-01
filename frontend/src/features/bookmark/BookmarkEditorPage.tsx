import { useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ArrowLeft, X, ZoomIn, ZoomOut } from "lucide-react";
import { createBookmark, renameNode, setBookmarkPages } from "../../api/actions";
import { ApiError, errorMessage } from "../../api/client";
import { queryClient, useBookmark, useNotebook } from "../../api/queries";
import type { BookmarkDetail } from "../../api/types";
import { formatRanges, rangesLabel, toRanges, type Range } from "../../lib/ranges";
import { plural } from "../../lib/format";
import { useDocumentTitle } from "../../lib/hooks";
import { toast } from "../../state/toasts";
import { PageGrid, useGridZoom, ZOOM_STEPS, type PageGridHandle } from "../notebook/PageGrid";
import { PagePreview } from "../notebook/PagePreview";
import { rebaseSelection, selectionForRangeText } from "./selection";

/** The bookmark as the user's edits started from it. */
interface Base {
  rev: number;
  name: string;
  pageIds: string[];
}

export function BookmarkEditorPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const isNew = !id;
  // Both are refetched when the editor opens, and editing starts from that data: a cached copy
  // can predate pages added to the bookmark (or a rename) since, and saving it would quietly
  // undo those changes. A new bookmark starts empty, so cached pages are fine for it.
  const bmQuery = useBookmark(id, { staleTime: 0 });
  const bookmark = bmQuery.data;
  const notebookId = isNew ? params.get("notebook") : bookmark?.notebook.id;
  const parentId = isNew ? params.get("parent") || null : (bookmark?.parent_id ?? null);
  const nbQuery = useNotebook(notebookId, { staleTime: 0 });
  const nb = nbQuery.data;
  const loading = isNew
    ? nbQuery.isLoading
    : !bmQuery.isFetchedAfterMount || (!!notebookId && !nbQuery.isFetchedAfterMount);
  const unavailable = !nb || !!nbQuery.error || (!isNew && !bookmark);
  const [ready, setReady] = useState(false);
  const [name, setName] = useState("New bookmark");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Text typed into the page-range field; null while the field just shows the selection.
  const [rangeDraft, setRangeDraft] = useState<string | null>(null);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  const [zoom, setZoom] = useGridZoom("picker", 1);
  const gridRef = useRef<PageGridHandle>(null);
  // Its rev is sent with the save, so changes made elsewhere meanwhile are reported, not overwritten.
  const base = useRef<Base | null>(null);
  // The selection from before the user started typing in the page-range field.
  const beforeTyping = useRef<Set<string>>(new Set());
  useDocumentTitle(isNew ? "New bookmark" : `Edit ${bookmark?.name ?? "bookmark"}`);

  const pages = useMemo(() => nb?.pages ?? [], [nb?.pages]);
  const numberOf = useMemo(() => new Map(pages.map((p, i) => [p.id, i + 1])), [pages]);
  // Selected pages that are (still) in the notebook, in notebook order.
  const picked = useMemo(() => pages.filter((p) => selected.has(p.id)).map((p) => p.id), [pages, selected]);

  useEffect(() => {
    if (ready || loading || unavailable) return;
    setReady(true);
    if (bookmark) {
      base.current = { rev: bookmark.rev, name: bookmark.name, pageIds: bookmark.page_ids };
      setName(bookmark.name);
      setSelected(new Set(bookmark.page_ids.filter((pid) => numberOf.has(pid))));
      const first = bookmark.page_ids.find((pid) => numberOf.has(pid));
      if (first) setTimeout(() => gridRef.current?.scrollToIndex((numberOf.get(first) ?? 1) - 1), 50);
    }
  }, [ready, loading, unavailable, bookmark, numberOf]);

  const ranges: Range[] = useMemo(
    () => toRanges([...selected].map((pid) => numberOf.get(pid)).filter((n): n is number => !!n)),
    [selected, numberOf],
  );

  function applyRangeText(text: string) {
    if (rangeDraft === null) beforeTyping.current = selected;
    const result = selectionForRangeText(text, pages, beforeTyping.current);
    setRangeDraft(text);
    setRangeError(result.error);
    setSelected(result.selected);
  }

  /** Changes the selection from outside the page-range field, replacing any text typed there. */
  function pick(next: SetStateAction<Set<string>>) {
    setRangeDraft(null);
    setRangeError(null);
    setSelected(next);
  }

  function removeRange([a, b]: Range) {
    pick((prev) => {
      const next = new Set(prev);
      for (let n = a; n <= b; n++) next.delete(pages[n - 1].id);
      return next;
    });
  }

  /** After a conflict (the bookmark and notebook have been reloaded), keeps the user's edits on top. */
  function rebase() {
    // The page-range field shows the reloaded selection rather than text typed against the old one.
    setRangeDraft(null);
    const fresh = bookmark && queryClient.getQueryData<BookmarkDetail>(["bookmark", bookmark.id]);
    const from = base.current;
    if (!fresh || !from || fresh.rev === from.rev) return;
    base.current = { rev: fresh.rev, name: fresh.name, pageIds: fresh.page_ids };
    setSelected((edited) => rebaseSelection(from.pageIds, edited, fresh.page_ids));
    setName((current) => (current.trim() === from.name ? fresh.name : current));
  }

  const back = () => {
    if (window.history.length > 1) navigate(-1);
    else navigate(parentId ? `/f/${parentId}` : "/");
  };

  async function save() {
    if (!nb) return;
    const cleanName = name.trim();
    if (!cleanName) {
      toast("Please give the bookmark a name.", { kind: "error" });
      return;
    }
    if (rangeError) {
      toast(rangeError, { kind: "error" });
      return;
    }
    if (!picked.length) {
      toast("Please select at least one page.", { kind: "error" });
      return;
    }
    setSaving(true);
    try {
      if (isNew) {
        const node = await createBookmark(parentId, cleanName, nb.id, picked);
        toast(`Bookmark “${node.name}” saved.`, {
          action: { label: "Read", onClick: () => navigate(`/read/b/${node.id}`) },
        });
        navigate(parentId ? `/f/${parentId}` : "/", { replace: true });
      } else if (bookmark && base.current) {
        const saved = await setBookmarkPages(bookmark.id, picked, base.current.rev);
        base.current = { ...base.current, rev: saved.rev, pageIds: saved.page_ids };
        // Only a name changed here is saved, so a rename made elsewhere meanwhile is kept.
        if (cleanName !== base.current.name) await renameNode(bookmark.id, cleanName);
        toast(`Bookmark “${cleanName}” saved.`);
        back();
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) rebase();
      toast(errorMessage(err), { kind: "error" });
    } finally {
      setSaving(false);
    }
  }

  if (nb?.trashed_at && !loading) {
    return (
      <div className="center-fill">
        <div className="empty">
          <h3>Notebook in Trash</h3>
          <p>
            “{nb.name}” is in the Trash. Restore it to {isNew ? "bookmark its pages" : "edit this bookmark"}.
          </p>
          <Link to={`/n/${nb.id}`}>Open the notebook</Link>
        </div>
      </div>
    );
  }

  if (!ready || !nb) {
    if (loading || !unavailable) {
      return (
        <div className="center-fill">
          <div className="spinner lg" />
        </div>
      );
    }
    return (
      <div className="center-fill">
        <div className="empty">
          <h3>Notebook unavailable</h3>
          <p>The notebook for this bookmark couldn't be found. It may be in the Trash.</p>
          <Link to="/">Go to your library</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="bm-editor">
      <header className="bm-editor-head">
        <button className="icon-btn" aria-label="Back" onClick={back}>
          <ArrowLeft />
        </button>
        <div className="bm-editor-title">
          <h1>{isNew ? "New bookmark" : "Edit bookmark"}</h1>
          <span className="muted">
            in <Link to={`/n/${nb.id}`}>{nb.name}</Link>
          </span>
        </div>
        <div className="bm-editor-actions">
          <button className="btn" onClick={back}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void save()}
            disabled={saving || !name.trim() || !!rangeError || !picked.length}
          >
            {saving ? "Saving…" : "Save bookmark"}
          </button>
        </div>
      </header>

      <div className="bm-editor-fields">
        <div className="field">
          <label htmlFor="bm-name">Name</label>
          <input
            id="bm-name"
            className="input"
            value={name}
            maxLength={255}
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => isNew && name === "New bookmark" && e.target.select()}
          />
        </div>
        <div className="field">
          <label htmlFor="bm-ranges">Pages</label>
          <input
            id="bm-ranges"
            className="input tabular"
            placeholder="e.g. 3-7, 10, 12-15"
            value={rangeDraft ?? formatRanges(ranges)}
            aria-invalid={!!rangeError}
            // Valid text is tidied up when leaving the field; invalid text stays, with its error.
            onBlur={() => !rangeError && setRangeDraft(null)}
            onChange={(e) => applyRangeText(e.target.value)}
          />
          <span className={rangeError ? "form-error" : "field-hint"} style={{ margin: 0 }}>
            {rangeError ?? "Type page ranges, or click and drag across the pages below."}
          </span>
        </div>
      </div>

      <div className="bm-editor-bar">
        <div className="chips">
          <strong className="tabular">{plural(picked.length, "page")}</strong>
          {ranges.length === 0 && <span className="faint">{rangesLabel(ranges)}</span>}
          {ranges.map((r) => (
            <span key={`${r[0]}-${r[1]}`} className="chip tabular">
              <button
                className="chip-label"
                onClick={() => gridRef.current?.scrollToIndex(r[0] - 1)}
                title="Show these pages"
                style={{ all: "unset", cursor: "pointer" }}
              >
                {r[0] === r[1] ? `p. ${r[0]}` : `pp. ${r[0]}–${r[1]}`}
              </button>
              <button aria-label={`Remove pages ${r[0]} to ${r[1]}`} onClick={() => removeRange(r)}>
                <X />
              </button>
            </span>
          ))}
        </div>
        <div className="bm-bar-actions">
          <button className="btn btn-sm btn-ghost" onClick={() => pick(new Set(pages.map((p) => p.id)))}>
            All
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => pick(new Set())}>
            None
          </button>
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => pick(new Set(pages.filter((p) => !selected.has(p.id)).map((p) => p.id)))}
          >
            Invert
          </button>
          <button className="icon-btn" aria-label="Smaller thumbnails" disabled={zoom === 0} onClick={() => setZoom(zoom - 1)}>
            <ZoomOut />
          </button>
          <button
            className="icon-btn"
            aria-label="Larger thumbnails"
            disabled={zoom === ZOOM_STEPS.length - 1}
            onClick={() => setZoom(zoom + 1)}
          >
            <ZoomIn />
          </button>
        </div>
      </div>

      <div className="bm-editor-grid">
        <PageGrid
          ref={gridRef}
          pages={pages}
          mode="pick"
          selected={selected}
          onSelectedChange={pick}
          tileWidth={ZOOM_STEPS[zoom]}
          onPreview={setPreview}
          ariaLabel={`Pages of ${nb.name}`}
        />
      </div>
      {preview !== null && (
        <PagePreview
          pages={pages}
          index={preview}
          onIndexChange={setPreview}
          onClose={() => setPreview(null)}
          labelFor={(i) => `Page ${i + 1} of ${pages.length}`}
          selected={selected}
          onToggle={(pid) =>
            pick((prev) => {
              const next = new Set(prev);
              if (next.has(pid)) next.delete(pid);
              else next.add(pid);
              return next;
            })
          }
        />
      )}
    </div>
  );
}
