import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ArrowLeft, CircleAlert, FileText, UploadCloud, X } from "lucide-react";
import { insertSource } from "../../api/actions";
import { ApiError, errorMessage } from "../../api/client";
import { queryClient, useNotebook } from "../../api/queries";
import type { NotebookDetail, UploadedSource } from "../../api/types";
import { isPdfFile, uploadPdf } from "../../api/upload";
import { PageThumb } from "../../components/PageThumb";
import { bookmarkColor } from "../../lib/colors";
import { formatBytes, plural } from "../../lib/format";
import { useDocumentTitle } from "../../lib/hooks";
import { toast } from "../../state/toasts";
import { Breadcrumbs } from "../explorer/ExplorerPage";
import { afterPageNumber, listedBookmarkIds } from "./uploadPosition";

interface QueuedFile {
  key: number;
  file: File;
  progress: number;
  status: "uploading" | "processing" | "ready" | "error";
  source?: UploadedSource;
  error?: string;
  abort?: () => void;
}

type Position = "end" | "start" | "after";

let nextKey = 1;

export function UploadPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { data: nb, isLoading, error: loadError } = useNotebook(id);
  useDocumentTitle(nb ? `Add PDF · ${nb.name}` : "Add PDF");
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const aborts = useRef(new Map<number, () => void>());
  const initialAfter = params.get("after");
  const [position, setPosition] = useState<Position>(
    initialAfter ? "after" : params.get("at") === "start" ? "start" : "end",
  );
  // "After page" follows a page id (?after=, or the last page added before a failed batch) until the user
  // picks a number, so a reload or reorder doesn't move the insertion point.
  const [afterAnchor, setAfterAnchor] = useState<string | null>(initialAfter);
  const [afterInput, setAfterInput] = useState(initialAfter ? "" : "1");
  const [addTo, setAddTo] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const touchedBookmarks = useRef(false);

  // Leaving the page cancels uploads that are still running.
  useEffect(() => {
    const running = aborts.current;
    return () => running.forEach((abort) => abort());
  }, []);

  const pageCount = nb?.pages.length ?? 0;
  const anchorIndex = afterAnchor && nb ? nb.pages.findIndex((p) => p.id === afterAnchor) : -1;
  const anchorMissing = position === "after" && !!afterAnchor && !!nb && anchorIndex < 0;
  const afterNumber = anchorIndex >= 0 ? anchorIndex + 1 : afterPageNumber(afterInput, pageCount);
  const k = position === "start" ? 0 : position === "end" ? pageCount : afterNumber;
  const prevPage = k > 0 ? nb?.pages[k - 1] : undefined;
  const nextPage = nb?.pages[k];

  function pickAfterPage(value: string) {
    setAfterAnchor(null);
    setAfterInput(value);
  }

  // Bookmarks around the insertion point: pre-check those containing both neighbours.
  const nearby = useMemo(() => {
    if (!nb) return [];
    return nb.bookmarks
      .map((b) => {
        const hasPrev = !!prevPage && b.page_ids.includes(prevPage.id);
        const hasNext = !!nextPage && b.page_ids.includes(nextPage.id);
        return { bookmark: b, both: hasPrev && hasNext, any: hasPrev || hasNext };
      })
      .filter((x) => x.any);
  }, [nb, prevPage, nextPage]);

  // A checked bookmark that drops out of the list is unchecked, so it can't get pages the user can't see.
  useEffect(() => {
    if (!touchedBookmarks.current) setAddTo(new Set(nearby.filter((x) => x.both).map((x) => x.bookmark.id)));
    else setAddTo((prev) => new Set(listedBookmarkIds(prev, nearby)));
  }, [nearby]);

  function addFiles(files: File[]) {
    const pdfs = files.filter(isPdfFile);
    if (pdfs.length < files.length) toast("Only PDF files can be added.");
    for (const file of pdfs) {
      const key = nextKey++;
      const handle = uploadPdf(file, (p) =>
        setQueue((q) => q.map((f) => (f.key === key ? { ...f, progress: p, status: p >= 1 ? "processing" : "uploading" } : f))),
      );
      aborts.current.set(key, handle.abort);
      setQueue((q) => [...q, { key, file, progress: 0, status: "uploading", abort: handle.abort }]);
      handle.promise.finally(() => aborts.current.delete(key)).then(
        (source) =>
          setQueue((q) => q.map((f) => (f.key === key ? { ...f, status: "ready", source, abort: undefined } : f))),
        (err) =>
          setQueue((q) =>
            q.map((f) => (f.key === key ? { ...f, status: "error", error: errorMessage(err), abort: undefined } : f)),
          ),
      );
    }
  }

  const ready = queue.filter((q) => q.status === "ready");
  const pending = queue.some((q) => q.status === "uploading" || q.status === "processing");
  const newPages = ready.reduce((sum, q) => sum + (q.source?.page_count ?? 0), 0);

  async function insertAll() {
    if (!nb || !ready.length || anchorMissing) return;
    setBusy(true);
    setError(null);
    const added: QueuedFile[] = [];
    let lastPageId: string | null = null;
    try {
      let detail: NotebookDetail = nb;
      let pos: Parameters<typeof insertSource>[2] =
        position === "after" && prevPage ? { at: "after", afterPageId: prevPage.id } : { at: position === "start" ? "start" : "end" };
      const bookmarkIds = listedBookmarkIds(addTo, nearby);
      for (const item of ready) {
        detail = await insertSource(detail, item.source!.id, pos, bookmarkIds);
        // Each insert is committed on its own: take the file off the queue so a retry doesn't add it twice.
        added.push(item);
        setQueue((q) => q.filter((f) => f.key !== item.key));
        const inserted = detail.inserted_page_ids ?? [];
        if (inserted.length) {
          lastPageId = inserted[inserted.length - 1];
          pos = { at: "after", afterPageId: lastPageId };
        }
      }
      toast(`Added ${plural(newPages, "page")} to “${nb.name}”.`);
      navigate(`/n/${nb.id}`);
    } catch (err) {
      let message = errorMessage(err);
      if (err instanceof ApiError && err.code === "stale_rev") {
        await queryClient.invalidateQueries({ queryKey: ["notebook", nb.id] });
        message = "The notebook changed while you were uploading. Check the position and try again.";
      }
      if (added.length) {
        // The remaining files continue after the pages already added, keeping the files in order.
        if (lastPageId) {
          setPosition("after");
          setAfterAnchor(lastPageId);
        }
        const names = added.map((f) => `“${f.file.name}”`).join(", ");
        message = `Added ${names}; the remaining files go after those pages. ${message}`;
      }
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  if (!nb && loadError) {
    return (
      <div className="center-fill">
        <div className="empty">
          <h3>{loadError instanceof ApiError && loadError.status === 404 ? "Notebook not found" : "Couldn't load notebook"}</h3>
          <p>It may have been moved to the Trash.</p>
          <Link to="/">Go to your library</Link>
        </div>
      </div>
    );
  }
  if (isLoading || !nb) {
    return (
      <div className="center-fill">
        <div className="spinner lg" />
      </div>
    );
  }
  if (nb.trashed_at) {
    // Reachable by Back or an old link; the server would reject the insert after the uploads.
    return (
      <div className="center-fill">
        <div className="empty">
          <h3>This notebook is in the Trash</h3>
          <p>Restore it to add pages.</p>
          <Link to={`/n/${nb.id}`}>Go to the notebook</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page-scroll">
      <div className="page-pad upload-page">
        <Breadcrumbs path={nb.path} />
        <div className="page-header">
          <div>
            <h1>Add PDF</h1>
            <p className="muted" style={{ margin: 0 }}>
              Pages are added to <Link to={`/n/${nb.id}`}>{nb.name}</Link> ({plural(pageCount, "page")} now).
            </p>
          </div>
          <div className="actions">
            <button className="btn" onClick={() => navigate(`/n/${nb.id}`)}>
              <ArrowLeft /> Back to notebook
            </button>
          </div>
        </div>

        <div
          className={`dropzone ${dragOver ? "over" : ""}`}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) {
              e.preventDefault();
              setDragOver(true);
            }
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            addFiles([...e.dataTransfer.files]);
          }}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
        >
          <UploadCloud />
          <strong>Drop PDF files here</strong>
          <span className="muted">or click to choose files</span>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            hidden
            onChange={(e) => {
              addFiles([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
        </div>

        {queue.length > 0 && (
          <ul className="upload-list">
            {queue.map((item) => (
              <li key={item.key} className={`upload-item ${item.status}`}>
                <div className="ui-thumb">
                  {item.source ? (
                    <PageThumb
                      page={{ ...item.source.pages[0], source_id: item.source.id, rotation: 0 }}
                      boxWidth={44}
                      boxHeight={56}
                    />
                  ) : item.status === "error" ? (
                    <CircleAlert />
                  ) : (
                    <FileText />
                  )}
                </div>
                <div className="ui-main">
                  <div className="ui-name truncate">{item.file.name}</div>
                  {item.status === "error" ? (
                    <div className="upload-error">{item.error}</div>
                  ) : item.status === "ready" ? (
                    <div className="muted ui-meta">
                      {plural(item.source!.page_count, "page")} · {formatBytes(item.file.size)}
                    </div>
                  ) : (
                    <div className={`progress ${item.status === "processing" ? "indeterminate" : ""}`}>
                      <div style={{ width: `${Math.round(item.progress * 100)}%` }} />
                    </div>
                  )}
                </div>
                <button
                  className="icon-btn icon-btn-sm"
                  aria-label="Remove"
                  onClick={() => {
                    item.abort?.();
                    setQueue((q) => q.filter((f) => f.key !== item.key));
                  }}
                >
                  <X />
                </button>
              </li>
            ))}
          </ul>
        )}

        <section className="card position-card">
          <h3>Where should the pages go?</h3>
          <div className="radio-cards">
            <label className="radio-card">
              <input type="radio" name="pos" checked={position === "end"} onChange={() => setPosition("end")} />
              At the end
            </label>
            <label className="radio-card">
              <input type="radio" name="pos" checked={position === "start"} onChange={() => setPosition("start")} />
              At the beginning
            </label>
            <label className="radio-card">
              <input
                type="radio"
                name="pos"
                checked={position === "after"}
                disabled={pageCount === 0}
                onChange={() => setPosition("after")}
              />
              After page…
            </label>
          </div>
          {position === "after" && pageCount > 0 && (
            <div className="after-picker">
              <label className="after-input">
                After page
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={pageCount}
                  value={anchorIndex >= 0 ? String(afterNumber) : afterInput}
                  onChange={(e) => pickAfterPage(e.target.value)}
                  onBlur={() => !afterAnchor && setAfterInput(String(afterNumber))}
                />
                <span className="muted">of {pageCount}</span>
              </label>
              <input
                type="range"
                min={1}
                max={pageCount}
                value={afterNumber}
                onChange={(e) => pickAfterPage(e.target.value)}
                aria-label="Insert after page"
              />
            </div>
          )}
          {anchorMissing && (
            <p className="form-error" role="alert">
              The page you chose is no longer in this notebook. Choose where the pages should go.
            </p>
          )}
          {pageCount > 0 && (
            <div className="insert-preview" aria-label="Insertion point">
              <div className="ip-page">
                {prevPage ? <PageThumb page={prevPage} boxWidth={90} boxHeight={116} /> : <div className="ip-none">Start</div>}
                <small>{prevPage ? `Page ${k}` : ""}</small>
              </div>
              <div className="ip-new">
                <span>{ready.length ? plural(newPages, "new page") : "New pages"}</span>
              </div>
              <div className="ip-page">
                {nextPage ? <PageThumb page={nextPage} boxWidth={90} boxHeight={116} /> : <div className="ip-none">End</div>}
                <small>{nextPage ? `Page ${k + 1}` : ""}</small>
              </div>
            </div>
          )}
          {nearby.length > 0 && (
            <div className="bookmark-extend">
              <h4>Also add the new pages to these bookmarks</h4>
              {nearby.map(({ bookmark }) => (
                <label key={bookmark.id} className="check">
                  <input
                    type="checkbox"
                    checked={addTo.has(bookmark.id)}
                    onChange={(e) => {
                      touchedBookmarks.current = true;
                      setAddTo((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(bookmark.id);
                        else next.delete(bookmark.id);
                        return next;
                      });
                    }}
                  />
                  <span>
                    <span className="bm-swatch inline" style={{ background: bookmarkColor(bookmark.id) }} />
                    {bookmark.name} <small>{bookmark.label}</small>
                  </span>
                </label>
              ))}
            </div>
          )}
        </section>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="upload-footer">
          <button className="btn" onClick={() => navigate(`/n/${nb.id}`)}>
            Cancel
          </button>
          <button
            className="btn btn-primary btn-lg"
            disabled={!ready.length || pending || busy || anchorMissing}
            onClick={() => void insertAll()}
          >
            {busy
              ? "Adding…"
              : pending
                ? "Waiting for uploads…"
                : ready.length
                  ? `Add ${plural(newPages, "page")}`
                  : "Add pages"}
          </button>
        </div>
      </div>
    </div>
  );
}
