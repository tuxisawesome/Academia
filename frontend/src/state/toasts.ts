import { create } from "zustand";
import { errorMessage } from "../api/client";

export interface Toast {
  id: number;
  message: string;
  kind: "info" | "error";
  action?: { label: string; onClick: () => void };
  duration: number;
}

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, "id">) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (toast) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...toast, id }] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export function toast(
  message: string,
  options: { action?: Toast["action"]; duration?: number; kind?: Toast["kind"] } = {},
): number {
  return useToasts.getState().push({
    message,
    kind: options.kind ?? "info",
    action: options.action,
    duration: options.duration ?? (options.action ? 8000 : 4000),
  });
}

export function toastError(err: unknown): void {
  toast(errorMessage(err), { kind: "error", duration: 6000 });
}
