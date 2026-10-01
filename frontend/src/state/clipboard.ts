import { create } from "zustand";

interface ClipboardState {
  mode: "cut" | "copy" | null;
  ids: string[];
  set: (mode: "cut" | "copy", ids: string[]) => void;
  clear: () => void;
}

export const useClipboard = create<ClipboardState>((set) => ({
  mode: null,
  ids: [],
  set: (mode, ids) => set({ mode, ids }),
  clear: () => set({ mode: null, ids: [] }),
}));
