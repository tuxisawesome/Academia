import { useEffect, useRef, useState } from "react";
import { useDialogs } from "../state/dialogs";
import { Modal } from "./Modal";

/** Renders the promise-based confirm/prompt dialogs (see state/dialogs.ts). */
export function DialogHost() {
  const pending = useDialogs((s) => s.pending);
  const close = useDialogs((s) => s.close);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (pending?.type === "prompt") setValue(pending.options.initial ?? "");
    if (pending?.type === "confirm") setValue("");
  }, [pending]);

  if (!pending) return null;

  const finish = (result: boolean) => {
    if (pending.type === "confirm") pending.resolve(result);
    else pending.resolve(result ? value.trim() || null : null);
    close();
  };

  if (pending.type === "confirm") {
    const o = pending.options;
    const blocked = !!o.typeToConfirm && value.trim() !== o.typeToConfirm;
    return (
      <Modal
        open
        onOpenChange={(open) => !open && finish(false)}
        title={o.title}
        description={o.message}
        footer={
          <>
            <button className="btn" onClick={() => finish(false)}>
              {o.cancelLabel ?? "Cancel"}
            </button>
            <button
              className={`btn ${o.danger ? "btn-danger" : "btn-primary"}`}
              disabled={blocked}
              onClick={() => finish(true)}
              autoFocus={!o.typeToConfirm}
            >
              {o.confirmLabel ?? "OK"}
            </button>
          </>
        }
      >
        {o.typeToConfirm ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!blocked) finish(true);
            }}
          >
            <div className="field">
              <label htmlFor="confirm-type">
                Type <strong>{o.typeToConfirm}</strong> to confirm
              </label>
              <input
                id="confirm-type"
                className="input"
                autoFocus
                autoComplete="off"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
          </form>
        ) : undefined}
      </Modal>
    );
  }

  const o = pending.options;
  return (
    <Modal
      open
      onOpenChange={(open) => !open && finish(false)}
      title={o.title}
      description={o.message}
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        const input = inputRef.current;
        if (input) {
          input.focus();
          const dot = o.selectAll === false ? -1 : input.value.length;
          input.setSelectionRange(0, dot < 0 ? input.value.length : dot);
        }
      }}
      footer={
        <>
          <button className="btn" onClick={() => finish(false)}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!value.trim()} onClick={() => finish(true)}>
            {o.confirmLabel ?? "OK"}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) finish(true);
        }}
      >
        <div className="field" style={{ marginBottom: 4 }}>
          {o.label && <label htmlFor="prompt-input">{o.label}</label>}
          <input
            id="prompt-input"
            ref={inputRef}
            className="input"
            value={value}
            placeholder={o.placeholder}
            maxLength={255}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
      </form>
    </Modal>
  );
}
