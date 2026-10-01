import { create } from "zustand";
import type { ReadingStatus } from "../../api/types";

export type RecognitionPhase =
  | "off" // disabled on this device
  | "checking" // detecting WebGPU support
  | "unsupported" // this browser/device can't run the model
  | "other-tab" // another tab of this browser is doing the work
  | "loading" // downloading / preparing the model
  | "reading" // recognising pages
  | "idle" // nothing left to read
  | "error";

interface RecognitionState {
  phase: RecognitionPhase;
  /** Model download progress (bytes). */
  loaded: number;
  total: number;
  /** Pages read on this device since the app was opened. */
  readThisSession: number;
  server: ReadingStatus | null;
  error: string | null;
  set: (patch: Partial<Omit<RecognitionState, "set">>) => void;
}

export const useRecognition = create<RecognitionState>((set) => ({
  phase: "checking",
  loaded: 0,
  total: 0,
  readThisSession: 0,
  server: null,
  error: null,
  set: (patch) => set(patch),
}));

const ENABLED_KEY = "academia-recognition-enabled";
const DEVICE_KEY = "academia-device-id";

/** Per-device choice: null = not decided yet (use the default for this device). */
export function storedEnabled(): boolean | null {
  try {
    const v = localStorage.getItem(ENABLED_KEY);
    return v === null ? null : v === "1";
  } catch {
    return null;
  }
}

export function storeEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, enabled ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** Phones and small tablets don't read by default (battery); computers do. */
export function defaultEnabled(): boolean {
  return !(window.matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 820);
}

export function deviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return "device-unknown";
  }
}
