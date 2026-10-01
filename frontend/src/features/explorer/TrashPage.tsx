import { ContextMenu } from "radix-ui";
import { useMemo, useState } from "react";
import { ArchiveRestore, Trash2, X } from "lucide-react";
import { emptyTrash, purgeNodes, restoreNodes } from "../../api/actions";
import { errorMessage } from "../../api/client";
import { useTrash } from "../../api/queries";
import type { LibraryNode } from "../../api/types";
import { ContextMenuContent, type MenuEntry } from "../../components/Menu";
import { plural } from "../../lib/format";
import { useDocumentTitle, useIsCoarse, useLongPressMenu } from "../../lib/hooks";
import { shortcutKey } from "../../lib/keys";
import { confirmDialog } from "../../state/dialogs";
import { toast, toastError } from "../../state/toasts";
import { ListView } from "./ItemViews";
import { useNodeActions } from "./nodeActions";
import { useSelection } from "./useSelection";

export function TrashPage() {
  useDocumentTitle("Trash");
  const { data, isLoading, error, refetch } = useTrash();
  const coarse = useIsCoarse();
  const items = useMemo(() => data ?? [], [data]);
  const ids = useMemo(() => items.map((i) => i.id), [items]);
  const selection = useSelection(ids);
  const [menuTargets, setMenuTargets] = useState<LibraryNode[]>([]);
  const actions = useNodeActions({ folderId: null });
  const selected = items.filter((i) => selection.selected.has(i.id));

  const restore = async (targets: LibraryNode[]) => {
    try {
      await restoreNodes(targets.map((t) => t.id));
      selection.clear();
      toast(targets.length === 1 ? `Restored “${targets[0].name}”.` : `Restored ${plural(targets.length, "item")}.`);
    } catch (err) {
      toastError(err);
    }
  };

  const purge = async (targets: LibraryNode[]) => {
    const ok = await confirmDialog({
      title: targets.length === 1 ? `Delete “${targets[0].name}” forever?` : `Delete ${plural(targets.length, "item")} forever?`,
      message:
        "This can't be undone. Bookmarks anywhere in your library that point into deleted notebooks are deleted too.",
      confirmLabel: "Delete forever",
      danger: true,
    });
    if (!ok) return;
    try {
      await purgeNodes(targets.map((t) => t.id));
      selection.clear();
    } catch (err) {
      toastError(err);
    }
  };

  const empty = async () => {
    const ok = await confirmDialog({
      title: "Empty the Trash?",
      message: `All ${plural(items.length, "item")} in the Trash will be permanently deleted. This can't be undone.`,
      confirmLabel: "Empty Trash",
      danger: true,
    });
    if (!ok) return;
    try {
      await emptyTrash();
      toast("The Trash has been emptied.");
    } catch (err) {
      toastError(err);
    }
  };

  /** Sets the right-click menu's targets for a click on `target`; false where no menu applies. */
  const targetMenuAt = (target: HTMLElement): boolean => {
    const el = target.closest<HTMLElement>("[data-node-id]");
    if (!el) {
      setMenuTargets([]);
      return false;
    }
    const id = el.dataset.nodeId!;
    if (!selection.selected.has(id)) selection.selectOnly(id);
    setMenuTargets(selection.selected.has(id) ? selected : items.filter((i) => i.id === id));
    return true;
  };
  const longPress = useLongPressMenu(targetMenuAt);

  const entries = (targets: LibraryNode[]): MenuEntry[] => [
    { label: "Restore", icon: <ArchiveRestore />, onSelect: () => void restore(targets) },
    { type: "sep" },
    { label: "Delete forever", icon: <Trash2 />, danger: true, onSelect: () => void purge(targets) },
  ];

  return (
    <div className="explorer">
      <div className="explorer-bar">
        <h2 className="bar-title">
          <Trash2 size={20} /> Trash
        </h2>
        <span className="muted hide-narrow">Items are deleted permanently after 30 days.</span>
        <div className="explorer-actions">
          {selected.length > 0 && (
            <>
              <button className="btn" onClick={() => void restore(selected)}>
                <ArchiveRestore /> Restore
              </button>
              <button className="btn" onClick={() => void purge(selected)}>
                <Trash2 /> Delete forever
              </button>
              <button className="icon-btn" aria-label="Clear selection" onClick={selection.clear}>
                <X />
              </button>
            </>
          )}
          <button className="btn btn-danger" disabled={!items.length} onClick={() => void empty()}>
            Empty Trash
          </button>
        </div>
      </div>
      <ContextMenu.Root onOpenChange={longPress.onOpenChange}>
        <ContextMenu.Trigger asChild>
          <div
            className="explorer-content"
            tabIndex={0}
            onPointerDownCapture={longPress.onPointerDownCapture}
            onContextMenuCapture={longPress.onContextMenuCapture}
            onContextMenu={(e) => {
              if (!targetMenuAt(e.target as HTMLElement)) e.preventDefault();
            }}
            onKeyDown={(e) => {
              // Keys already handled by a control in the list (the "…" button), or typed in its portalled menu.
              if (e.defaultPrevented || !e.currentTarget.contains(e.target as Node)) return;
              if ((e.ctrlKey || e.metaKey) && shortcutKey(e) === "a") {
                e.preventDefault();
                selection.selectAll();
              }
              if (e.key === "Delete" && selected.length && !e.repeat) void purge(selected);
              if (e.key === "Escape") selection.clear();
            }}
          >
            {isLoading ? (
              <div className="center-fill">
                <div className="spinner lg" />
              </div>
            ) : error && !data ? (
              <div className="center-fill">
                <div className="empty">
                  <h3>Couldn't load the Trash</h3>
                  <p>{errorMessage(error)}</p>
                  <button className="btn" onClick={() => void refetch()}>
                    Try again
                  </button>
                </div>
              </div>
            ) : items.length === 0 ? (
              <div className="center-fill">
                <div className="empty">
                  <Trash2 className="empty-icon" />
                  <h3>The Trash is empty</h3>
                  <p>Deleted folders, notebooks and bookmarks stay here for 30 days.</p>
                </div>
              </div>
            ) : (
              <ListView
                items={items}
                selection={selection}
                actions={actions}
                folderId={null}
                renamingId={null}
                onRenameDone={() => undefined}
                cutIds={new Set()}
                touch={coarse}
                variant="trash"
                onOpen={(node) => actions.showProperties(node)}
                entriesFor={entries}
              />
            )}
          </div>
        </ContextMenu.Trigger>
        {menuTargets.length > 0 && <ContextMenuContent entries={entries(menuTargets)} />}
      </ContextMenu.Root>
      {actions.dialogs}
    </div>
  );
}
