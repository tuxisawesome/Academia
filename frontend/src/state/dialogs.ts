import { create } from "zustand";
import { onSessionEnd } from "../api/queries";

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** When set, the user must type this text to enable the confirm button. */
  typeToConfirm?: string;
}

export interface PromptOptions {
  title: string;
  message?: string;
  label?: string;
  initial?: string;
  confirmLabel?: string;
  placeholder?: string;
  selectAll?: boolean;
}

type Pending =
  | { type: "confirm"; options: ConfirmOptions; resolve: (ok: boolean) => void }
  | { type: "prompt"; options: PromptOptions; resolve: (value: string | null) => void };

interface DialogState {
  pending: Pending | null;
  open: (p: Pending) => void;
  close: () => void;
}

export const useDialogs = create<DialogState>((set) => ({
  pending: null,
  open: (pending) => set({ pending }),
  close: () => set({ pending: null }),
}));

// A confirm or prompt still open when the session ends is cancelled, not answered by the next user.
onSessionEnd(() => {
  const pending = useDialogs.getState().pending;
  if (pending?.type === "confirm") pending.resolve(false);
  else if (pending?.type === "prompt") pending.resolve(null);
  useDialogs.getState().close();
});

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => useDialogs.getState().open({ type: "confirm", options, resolve }));
}

export function promptDialog(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => useDialogs.getState().open({ type: "prompt", options, resolve }));
}
