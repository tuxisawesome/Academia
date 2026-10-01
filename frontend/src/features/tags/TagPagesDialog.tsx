import { useState } from "react";
import { tagPages } from "../../api/actions";
import { useClassMap } from "../../api/queries";
import type { PageRef } from "../../api/types";
import { ClassChip, ClassPicker } from "../../components/ClassPicker";
import { Modal } from "../../components/Modal";
import { FIRST_DAY, isTagDay, LAST_DAY, plural } from "../../lib/format";
import { toast, toastError } from "../../state/toasts";
import { tagChanges, tagState } from "./tags";

/** Pages of one notebook to tag (a bookmark's pages are tagged in their notebook). */
export interface TagTarget {
  notebookId: string;
  /** The pages, with the tags they have now. */
  pages: PageRef[];
  /** Says which pages these are, e.g. "pp. 3–5 of “Lecture Notes”". */
  description?: string;
}

export function TagPagesDialog({ target, onClose }: { target: TagTarget | null; onClose: () => void }) {
  // Mounted per opening, so each one starts from the pages' tags.
  return target ? <TagPagesDialogBody target={target} onClose={onClose} /> : null;
}

function TagPagesDialogBody({ target, onClose }: { target: TagTarget; onClose: () => void }) {
  const classes = useClassMap();
  const [initial] = useState(() => tagState(target.pages));
  // undefined: the date is left as it was.
  const [date, setDate] = useState<string | null | undefined>(undefined);
  const [all, setAll] = useState(initial.all);
  const [some, setSome] = useState(initial.some);
  // A date only partly typed (the input's value is then empty), or out of the years tags can have.
  const [badDate, setBadDate] = useState(false);
  // Remounts the date input to empty it: a partly typed date isn't its value.
  const [dateKey, setDateKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const changes = badDate ? null : tagChanges(initial, { date, all, some });
  const mixed = date === undefined && initial.date === "mixed";
  const shownDate = date !== undefined ? (date ?? "") : initial.date === "mixed" ? "" : (initial.date ?? "");
  const count = target.pages.length;
  // Chips in the order of the user's classes; ones deleted meanwhile are left out.
  const inOrder = (ids: string[]) => [...(classes?.values() ?? [])].filter((c) => ids.includes(c.id));

  const save = async () => {
    if (!changes || saving) return;
    setSaving(true);
    try {
      await tagPages(
        target.notebookId,
        target.pages.map((p) => p.id),
        changes,
      );
      toast(`Tagged ${plural(count, "page")}.`);
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Tag ${plural(count, "page")}`}
      description={target.description}
      modalLock={saving}
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        document.getElementById("tag-classes")?.focus();
      }}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!changes || saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save tags"}
          </button>
        </>
      }
    >
      <form
        className="tag-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="field">
          <label htmlFor="tag-date">Date</label>
          <div className="tag-date-row">
            <input
              key={dateKey}
              id="tag-date"
              type="date"
              className="input"
              min={FIRST_DAY}
              max={LAST_DAY}
              value={shownDate}
              aria-invalid={badDate}
              aria-describedby={badDate ? "tag-date-error" : mixed ? "tag-date-mixed" : undefined}
              onChange={(e) => {
                const day = e.target.value;
                setDate(day || null);
                setBadDate(e.target.validity.badInput || (!!day && !isTagDay(day)));
              }}
            />
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!shownDate && !mixed && !badDate}
              onClick={() => {
                setDate(null);
                setBadDate(false);
                setDateKey((k) => k + 1);
              }}
            >
              Clear date
            </button>
          </div>
          {badDate ? (
            <span id="tag-date-error" className="field-hint">
              Finish the date (between 1900 and 2200), or clear it.
            </span>
          ) : (
            mixed && (
              <span id="tag-date-mixed" className="field-hint">
                Mixed: these pages have different dates. They keep them unless you choose one for all of them.
              </span>
            )
          )}
        </div>
        <div className="field">
          <label htmlFor="tag-classes">Classes</label>
          {all.length + some.length > 0 && (
            <div className="chips tag-chips">
              {inOrder(all).map((c) => (
                <ClassChip key={c.id} item={c} onRemove={() => setAll(all.filter((id) => id !== c.id))} />
              ))}
              {inOrder(some).map((c) => (
                <ClassChip
                  key={c.id}
                  item={c}
                  partial
                  title={`On some of these pages. Click to tag all ${plural(count, "page")}.`}
                  onClick={() => {
                    setSome(some.filter((id) => id !== c.id));
                    setAll([...all, c.id]);
                  }}
                  onRemove={() => setSome(some.filter((id) => id !== c.id))}
                />
              ))}
            </div>
          )}
          <ClassPicker
            id="tag-classes"
            label="Add a class"
            placeholder="Find or add a class…"
            chips={false}
            value={all}
            onChange={(ids) => {
              setAll(ids);
              setSome(some.filter((id) => !ids.includes(id)));
            }}
          />
          {some.length > 0 && (
            <span className="field-hint">
              Dimmed classes are on some of these pages only: click one to tag all of them.
            </span>
          )}
        </div>
      </form>
    </Modal>
  );
}
