import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ArrowLeft, X, ZoomIn, ZoomOut } from "lucide-react";
import { createBookmark, renameNode, setBookmarkPages } from "../../api/actions";
import { errorMessage } from "../../api/client";
import { useBookmark, useNotebook } from "../../api/queries";
import { formatRanges, parseRanges, rangesLabel, toRanges, type Range } from "../../lib/ranges";
import { plural } from "../../lib/format";
import { useDocumentTitle } from "../../lib/hooks";
import { toast } from "../../state/toasts";
import { PageGrid, useGridZoom, ZOOM_STEPS, type PageGridHandle } from "../notebook/PageGrid";
import { PagePreview } from "../notebook/PagePreview";

export function BookmarkEditorPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const isNew = !id;
  const { data: bookmark, isLoading: bmLoading } = useBookmark(id);
  const notebookId = isNew ? params.get("notebook") : bookmark?.notebook.id;
  const parentId = isNew ? params.get("parent") || null : (bookmark?.parent_id ?? null);
  const { data: nb, isLoading: nbLoading, error: nbError } = useNotebook(notebookId);
  const [name, setName] = useState("New bookmark");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rangeText, setRangeText] = useState("");
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [editingRange, setEditingRange] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  const [zoom, setZoom] = useGridZoom("picker", 1);
  const gridRef = useRef<PageGridHandle>(null);
  const initialized = useRef(false);
  useDocumentTitle(isNew ? "New bookmark" : `Edit ${bookmark?.name ?? "bookmark"}`);

  const pages = useMemo(() => nb?.pages ?? [], [nb?.pages]);
  const numberOf = useMemo(() => new Map(pages.map((p, i) => [p.id, i + 1])), [pages]);

  useEffect(() => {
    if (initialized.current || !nb) return;
    if (!isNew && !bookmark) return;
    initialized.current = true;
    if (bookmark) {
      setName(bookmark.name);
      setSelected(new Set(bookmark.page_ids.filter((pid) => numberOf.has(pid))));
      const first = bookmark.page_ids.find((pid) => numberOf.has(pid));
      if (first) setTimeout(() => gridRef.current?.scrollToIndex((numberOf.get(first) ?? 1) - 1), 50);
    }
  }, [nb, bookmark, isNew, numberOf]);

  const ranges: Range[] = useMemo(
    () => toRanges([...selected].map((pid) => numberOf.get(pid)).filter((n): n is number => !!n)),
    [selected, numberOf],
  );

  // Keep the range text in sync with the grid unless the user is typing in it.
  useEffect(() => {
    if (!editingRange) {
      setRangeText(formatRanges(ranges));
      setRangeError(null);
    }
  }, [ranges, editingRange]);

  function applyRangeText(text: string) {
    setRangeText(text);
    const result = parseRanges(text, pages.length);
    setRangeError(result.error);
    if (!result.error) setSelected(new Set(result.numbers.map((n) => pages[n - 1].id)));
  }

  function removeRange([a, b]: Range) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (let n = a; n <= b; n++) next.delete(pages[n - 1].id);
      return next;
    });
  }

  const back = () => {
    if (window.history.length > 1) navigate(-1);
    else navigate(parentId ? `/f/${parentId}` : "/");
  };

  async function save() {
    if (!nb) return;
    const ids = pages.filter((p) => selected.has(p.id)).map((p) => p.id);
    const cleanName = name.trim();
    if (!cleanName) {
      toast("Please give the bookmark a name.", { kind: "error" });
      return;
    }
    setSaving(true);
    try {
      if (isNew) {
        const node = await createBookmark(parentId, cleanName, nb.id, ids);
        toast(`Bookmark “${node.name}” saved.`, {
          action: { label: "Read", onClick: () => navigate(`/read/b/${node.id}`) },
        });
        navigate(parentId ? `/f/${parentId}` : "/", { replace: true });
      } else if (bookmark) {
        await setBookmarkPages(bookmark.id, ids);
        if (cleanName !== bookmark.name) await renameNode(bookmark.id, cleanName);
        toast(`Bookmark “${cleanName}” saved.`);
        back();
      }
    } catch (err) {
      toast(errorMessage(err), { kind: "error" });
    } finally {
      setSaving(false);
    }
  }

  if (bmLoading || nbLoading) {
    return (
      <div className="center-fill">
        <div className="spinner lg" />
      </div>
    );
  }
  if (!nb || nbError || (!isNew && !bookmark)) {
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
          <button className="btn btn-primary" onClick={() => void save()} disabled={saving || !name.trim()}>
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
            value={rangeText}
            aria-invalid={!!rangeError}
            onFocus={() => setEditingRange(true)}
            onBlur={() => setEditingRange(false)}
            onChange={(e) => applyRangeText(e.target.value)}
          />
          <span className={rangeError ? "form-error" : "field-hint"} style={{ margin: 0 }}>
            {rangeError ?? "Type page ranges, or click and drag across the pages below."}
          </span>
        </div>
      </div>

      <div className="bm-editor-bar">
        <div className="chips">
          <strong className="tabular">{plural(selected.size, "page")}</strong>
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
          <button className="btn btn-sm btn-ghost" onClick={() => setSelected(new Set(pages.map((p) => p.id)))}>
            All
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setSelected(new Set())}>
            None
          </button>
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => setSelected(new Set(pages.filter((p) => !selected.has(p.id)).map((p) => p.id)))}
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
          onSelectedChange={setSelected}
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
            setSelected((prev) => {
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
