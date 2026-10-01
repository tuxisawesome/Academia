import { Popover } from "radix-ui";
import { Check, Plus, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createClass } from "../api/actions";
import { useClasses } from "../api/queries";
import type { ClassItem } from "../api/types";
import { classNamed, cleanClassName, matchClasses } from "../lib/classes";
import { folderColorVar } from "../lib/colors";
import { isImeKey } from "../lib/keys";
import { toastError } from "../state/toasts";

/** A class as a chip: its color and name, with a remove button when `onRemove` is given. */
export function ClassChip({
  item,
  onRemove,
  onClick,
  partial = false,
  title,
}: {
  item: ClassItem;
  onRemove?: () => void;
  /** Makes the name a button. */
  onClick?: () => void;
  /** Shown dimmed: the class is on only some of the pages. */
  partial?: boolean;
  title?: string;
}) {
  return (
    <span className={`chip class-chip ${partial ? "partial" : ""}`} title={title}>
      <span className="class-dot" style={{ background: folderColorVar(item.color) }} aria-hidden="true" />
      {onClick ? (
        <button type="button" className="chip-label truncate" onClick={onClick}>
          {item.name}
        </button>
      ) : (
        <span className="truncate">{item.name}</span>
      )}
      {onRemove && (
        <button type="button" aria-label={`Remove ${item.name}`} onClick={onRemove}>
          <X />
        </button>
      )}
    </span>
  );
}

type Option = { kind: "class"; item: ClassItem } | { kind: "new"; name: string };

interface ClassPickerProps {
  /** Ids of the chosen classes. */
  value: string[];
  onChange: (ids: string[]) => void;
  /** Accessible name of the text box. */
  label: string;
  id?: string;
  placeholder?: string;
  /** Shows the chosen classes as removable chips; off when the parent shows them itself. */
  chips?: boolean;
  /** Offers to create a class named as typed when there is none. */
  allowCreate?: boolean;
}

/**
 * Chooses any number of the user's classes: typing filters them (ignoring case and accents),
 * arrow keys and Enter pick one, Esc closes the list. Picking a chosen class again unchooses it.
 */
export function ClassPicker({
  value,
  onChange,
  label,
  id,
  placeholder = "Find a class…",
  chips = true,
  allowCreate = true,
}: ClassPickerProps) {
  const { data: classes = [] } = useClasses();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [creating, setCreating] = useState(false);
  const fieldRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (i: number) => `${baseId}-option-${i}`;

  const chosen = new Set(value);
  const newName = allowCreate && !classNamed(classes, text) ? cleanClassName(text).slice(0, 80) : "";
  const options: Option[] = [
    ...matchClasses(classes, text).map((item) => ({ kind: "class" as const, item })),
    ...(newName ? [{ kind: "new" as const, name: newName }] : []),
  ];
  const current = Math.min(active, options.length - 1);

  useEffect(() => {
    if (open && current >= 0) document.getElementById(optionId(current))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, current]);

  const toggle = (classId: string) =>
    onChange(chosen.has(classId) ? value.filter((v) => v !== classId) : [...value, classId]);

  const choose = async (option: Option) => {
    if (option.kind === "class") {
      toggle(option.item.id);
      // Closed so it doesn't cover what comes next (a dialog's Save button); typing, ArrowDown or
      // a click opens the whole list again, still at the class just picked.
      setActive(Math.max(0, classes.indexOf(option.item)));
      setText("");
      setOpen(false);
      return;
    }
    if (creating) return;
    setCreating(true);
    try {
      const item = await createClass(option.name);
      onChange([...value, item.id]);
      setText("");
      setActive(0);
      setOpen(false);
    } catch (err) {
      toastError(err);
    } finally {
      setCreating(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (isImeKey(e.nativeEvent)) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (open) setActive(Math.min(current + 1, options.length - 1));
      else setOpen(true);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (open) setActive(Math.max(current - 1, 0));
    } else if (e.key === "Enter") {
      // Never submits a surrounding form while the list is open.
      if (!open) return;
      e.preventDefault();
      if (current >= 0) void choose(options[current]);
    } else if (e.key === "Escape") {
      // The open list is the top layer, so this Esc doesn't close a dialog the picker is in.
      if (open) setOpen(false);
    } else if (e.key === "Backspace" && chips && !text && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  const shownChips = chips ? classes.filter((c) => chosen.has(c.id)) : [];
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <div className="class-picker input" ref={fieldRef} onClick={() => inputRef.current?.focus()}>
          {shownChips.map((item) => (
            <ClassChip key={item.id} item={item} onRemove={() => toggle(item.id)} />
          ))}
          <input
            ref={inputRef}
            id={id}
            role="combobox"
            aria-label={label}
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && current >= 0 ? optionId(current) : undefined}
            autoComplete="off"
            maxLength={80}
            placeholder={placeholder}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setActive(0);
              setOpen(true);
            }}
            onClick={() => setOpen(true)}
            onKeyDown={onKeyDown}
            // Tabbing on to the next control closes the list (picking keeps the focus here).
            onBlur={(e) => {
              if (!fieldRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
            }}
          />
        </div>
      </Popover.Anchor>
      <Popover.Content
        asChild
        align="start"
        sideOffset={4}
        collisionPadding={8}
        // Focus stays in the text box: the list is only pointed at (aria-activedescendant).
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => {
          if (fieldRef.current?.contains(e.target as Node)) e.preventDefault();
        }}
      >
        <ul id={listId} role="listbox" aria-label={label} aria-multiselectable="true" className="menu class-options">
          {options.length === 0 && (
            <li role="option" aria-disabled="true" aria-selected="false" className="class-options-empty">
              {classes.length
                ? "No class matches."
                : allowCreate
                  ? "No classes yet: type a name to add one."
                  : "No classes yet. Add them in Settings → Classes."}
            </li>
          )}
          {options.map((option, i) => (
            <li
              key={option.kind === "class" ? option.item.id : "new"}
              id={optionId(i)}
              role="option"
              aria-selected={option.kind === "class" && chosen.has(option.item.id)}
              aria-disabled={option.kind === "new" && creating}
              className="menu-item"
              data-highlighted={i === current ? "" : undefined}
              // Keeps the focus in the text box.
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => i !== current && setActive(i)}
              onClick={() => void choose(option)}
            >
              {option.kind === "class" ? (
                <>
                  <span style={{ width: 16, display: "inline-grid" }}>{chosen.has(option.item.id) && <Check />}</span>
                  <span className="class-dot" style={{ background: folderColorVar(option.item.color) }} />
                  <span className="truncate">{option.item.name}</span>
                </>
              ) : (
                <>
                  <Plus />
                  <span className="truncate">Add class “{option.name}”</span>
                </>
              )}
            </li>
          ))}
        </ul>
      </Popover.Content>
    </Popover.Root>
  );
}
