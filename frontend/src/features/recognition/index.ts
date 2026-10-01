/**
 * Lightweight entry point for handwriting recognition. The controller (with pdf.js and the
 * model worker) is only downloaded when recognition actually starts.
 */
import { defaultEnabled, storedEnabled, storeEnabled, useRecognition } from "./store";

type ControllerModule = typeof import("./controller");
let loading: Promise<ControllerModule> | null = null;

function controller(): Promise<ControllerModule> {
  loading ??= import("./controller");
  return loading;
}

export function recognitionEnabled(): boolean {
  return storedEnabled() ?? defaultEnabled();
}

export function startRecognition(): void {
  if (!recognitionEnabled()) {
    useRecognition.getState().set({ phase: "off" });
    return;
  }
  void controller().then((m) => m.recognition.init());
}

export function setRecognitionEnabled(enabled: boolean): void {
  storeEnabled(enabled);
  void controller().then((m) => m.recognition.setEnabled(enabled));
}

/** New pages may need reading (e.g. an upload finished). */
export function pokeRecognition(): void {
  if (loading) void loading.then((m) => m.recognition.poke());
}

/** The model choice for this device changed. */
export function restartRecognition(): void {
  if (!recognitionEnabled()) return;
  void controller().then((m) => m.recognition.restart());
}

/** Stop reading in this tab (e.g. on sign-out). */
export function stopRecognition(): void {
  if (loading) void loading.then((m) => m.recognition.stop());
}
