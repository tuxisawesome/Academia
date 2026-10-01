import { ContextMenu } from "radix-ui";
import { useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ChevronRight, FileText, Folder, Search, X } from "lucide-react";
import { renameNode } from "../../api/actions";
import { errorMessage } from "../../api/client";
import { useSearch } from "../../api/queries";
import type { ContentResult, LibraryNode } from "../../api/types";
import { NodeGlyph } from "../../components/Glyphs";
import { ContextMenuContent } from "../../components/Menu";
import { PageThumb } from "../../components/PageThumb";
import { plural } from "../../lib/format";
import { useDocumentTitle, useIsCoarse, useLongPressMenu } from "../../lib/hooks";
import { useClipboard } from "../../state/clipboard";
import { toastError } from "../../state/toasts";
import { focusRenameInput, ListView } from "./ItemViews";
import { useNodeActions } from "./nodeActions";
import { useSelection } from "./useSelection";

const SECTIONS_KEY = "academia-search-sections";

function loadSections(): { files: boolean; contents: boolean } {
  try {
    return { files: true, contents: true, ...JSON.parse(localStorage.getItem(SECTIONS_KEY) || "{}") };
  } catch {
    return { files: true, contents: true };
  }
}

function Section({
  title,
  icon,
  count,
  open,
  onToggle,
  busy,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  count: number | null;
  open: boolean;
  onToggle: () => void;
  busy?: boolean;
  children: React.ReactNode;
}) {
  const id = `search-section-${title.toLowerCase()}`;
  return (
    <section className={`search-section ${open ? "open" : ""}`}>
      <h3>
        <button className="section-toggle" aria-expanded={open} aria-controls={id} onClick={onToggle}>
          <ChevronRight className="chev" size={16} />
          {icon}
          <span>{title}</span>
          {count !== null && <span className="badge">{count.toLocaleString()}</span>}
          {busy && <span className="spinner" aria-label="Searching" />}
        </button>
      </h3>
      {open && (
        <div className="section-body" id={id}>
          {children}
        </div>
      )}
    </section>
  );
}

function ContentHit({ item, onMenu }: { item: ContentResult; onMenu: (node: LibraryNode) => void }) {
  const navigate = useNavigate();
  const kind = item.kind === "bookmark" ? "b" : "n";
  const openItem = () => navigate(item.kind === "bookmark" ? `/read/b/${item.id}` : `/n/${item.id}`);
  const more = item.match_count - item.matches.length;
  return (
    <article className="content-hit" data-node-id={item.id} onContextMenu={() => onMenu(item)}>
      <header>
        <NodeGlyph kind={item.kind} color={item.color} size={22} />
        <button className="hit-name truncate" onClick={openItem}>
          {item.name}
        </button>
        <span className="hit-location truncate">{item.location || "Library"}</span>
        <span className="hit-count tabular">{plural(item.match_count, "page")}</span>
      </header>
      <div className="hit-pages" role="list">
        {item.matches.map((m) => (
          <button
            key={m.id}
            role="listitem"
            className="hit-page"
            title={`Open page ${m.number}`}
            onClick={() => navigate(`/read/${kind}/${item.id}?page=${m.open_page}`)}
          >
            <PageThumb page={m} boxWidth={78} boxHeight={100} />
            <span className="tabular">p. {m.number}</span>
          </button>
        ))}
        {more > 0 && <span className="hit-more tabular">+{more} more</span>}
      </div>
    </article>
  );
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const scopeId = params.get("in");
  useDocumentTitle(q ? `Search: ${q}` : "Search");
  const { data, error, isFetching } = useSearch(q, scopeId);
  const coarse = useIsCoarse();
  const clipboard = useClipboard();
  const [open, setOpen] = useState(loadSections);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [menuTargets, setMenuTargets] = useState<LibraryNode[]>([]);
  const contentRef = useRef<HTMLDivElement>(null);
  const files = useMemo(() => data?.files ?? [], [data]);
  const contents = data?.contents ?? [];
  const ids = useMemo(() => files.map((i) => i.id), [files]);
  const selection = useSelection(ids);
  // Inline renaming needs the item's row in the open Files section; anything else gets the rename dialog.
  const startRename = (id: string) => {
    if (!open.files || !files.some((f) => f.id === id)) return false;
    setRenamingId(id);
  };
  const actions = useNodeActions({ folderId: null, startRename, onRemoved: selection.clear });
  const cutIds = useMemo(() => new Set(clipboard.mode === "cut" ? clipboard.ids : []), [clipboard]);

  // A rename belongs to the results it was started in: a new query or scope cancels it before the
  // new results render (a rename box appearing there would take the focus from the search box).
  const resultsKey = `${scopeId ?? ""}/${q}`;
  const [renamingIn, setRenamingIn] = useState(resultsKey);
  if (renamingIn !== resultsKey) {
    setRenamingIn(resultsKey);
    setRenamingId(null);
  }

  const toggle = (key: "files" | "contents") => {
    const next = { ...open, [key]: !open[key] };
    setOpen(next);
    try {
      localStorage.setItem(SECTIONS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const searchEverywhere = () => {
    const next = new URLSearchParams(params);
    next.delete("in");
    setParams(next, { replace: true });
  };

  /** Sets the right-click menu's item for a click on `target`; false where no menu applies. */
  const targetMenuAt = (target: HTMLElement): boolean => {
    const el = target.closest<HTMLElement>("[data-node-id]");
    const id = el?.dataset.nodeId;
    const node = id ? (files.find((i) => i.id === id) ?? contents.find((i) => i.id === id) ?? null) : null;
    // Like the explorer: right-clicking a selected file acts on the whole selection (a
    // Contents hit is not part of it, even when the same item is selected under Files).
    if (node && !el?.classList.contains("content-hit") && selection.selected.has(node.id)) {
      setMenuTargets(files.filter((f) => selection.selected.has(f.id)));
    } else {
      if (node && files.some((f) => f.id === node.id)) selection.selectOnly(node.id);
      setMenuTargets(node ? [node] : []);
    }
    return !!node;
  };
  const longPress = useLongPressMenu(targetMenuAt);

  const scopeName = data?.scope?.name;

  return (
    <div className="explorer">
      <div className="explorer-bar search-bar">
        <h2 className="bar-title">
          <Search size={20} /> {q ? <>Results for “{q}”</> : "Search"}
        </h2>
        {q && (
          <span className="scope-chip">
            {scopeId ? (
              <>
                in{" "}
                <Link to={`/f/${scopeId}`} className="scope-name">
                  {scopeName ?? "this folder"}
                </Link>{" "}
                and its subfolders
                <button className="icon-btn icon-btn-sm" onClick={searchEverywhere} title="Search everywhere">
                  <X />
                </button>
              </>
            ) : (
              "in your whole library"
            )}
          </span>
        )}
      </div>
      <ContextMenu.Root onOpenChange={longPress.onOpenChange}>
        <ContextMenu.Trigger asChild>
          <div
            ref={contentRef}
            className="explorer-content search-results"
            tabIndex={0}
            onPointerDownCapture={longPress.onPointerDownCapture}
            onContextMenuCapture={longPress.onContextMenuCapture}
            onContextMenu={(e) => {
              if (!targetMenuAt(e.target as HTMLElement)) e.preventDefault();
            }}
          >
            {!q ? (
              <div className="center-fill">
                <div className="empty">
                  <h3>Search your library</h3>
                  <p>
                    Type in the search box above. Searching inside a folder looks through that folder and everything in
                    it; from the Library it looks everywhere.
                  </p>
                </div>
              </div>
            ) : error && !data ? (
              <div className="center-fill">
                <div className="empty">
                  <h3>Search failed</h3>
                  <p>{errorMessage(error)}</p>
                </div>
              </div>
            ) : (
              <>
                <Section
                  title="Files"
                  icon={<Folder size={17} />}
                  count={data ? files.length : null}
                  open={open.files}
                  onToggle={() => toggle("files")}
                  busy={isFetching}
                >
                  {files.length === 0 ? (
                    <p className="muted section-empty">No folders, notebooks or bookmarks are named like “{q}”.</p>
                  ) : (
                    <ListView
                      items={files}
                      selection={selection}
                      actions={actions}
                      folderId={null}
                      renamingId={renamingId}
                      onRenameDone={async (id, name) => {
                        setRenamingId(null);
                        const node = files.find((i) => i.id === id);
                        if (name && node && name !== node.name) await renameNode(id, name).catch(toastError);
                      }}
                      cutIds={cutIds}
                      touch={coarse}
                      variant="search"
                      entriesFor={(targets) =>
                        targets.length === 1 ? actions.searchEntries(targets[0]) : actions.itemEntries(targets)
                      }
                    />
                  )}
                </Section>
                <Section
                  title="Contents"
                  icon={<FileText size={17} />}
                  count={data ? contents.length : null}
                  open={open.contents}
                  onToggle={() => toggle("contents")}
                >
                  {contents.length === 0 ? (
                    <p className="muted section-empty">
                      No pages mention “{q}”. Only text that can be selected in a PDF is searched; scanned or handwritten
                      pages aren’t.
                    </p>
                  ) : (
                    <div className="content-hits">
                      {contents.map((item) => (
                        <ContentHit key={item.id} item={item} onMenu={(node) => setMenuTargets([node])} />
                      ))}
                    </div>
                  )}
                </Section>
              </>
            )}
          </div>
        </ContextMenu.Trigger>
        {menuTargets.length > 0 && (
          <ContextMenuContent
            entries={
              menuTargets.length === 1 ? actions.searchEntries(menuTargets[0]) : actions.itemEntries(menuTargets)
            }
            onCloseAutoFocus={(e) => focusRenameInput(e, contentRef.current)}
          />
        )}
      </ContextMenu.Root>
      {actions.dialogs}
    </div>
  );
}
