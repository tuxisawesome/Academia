/** Messages between the recognition controller (main thread) and the model worker. */

export type ToWorker =
  | { type: "load"; repo: string; revision: string; prompt: string }
  | { type: "recognize"; id: number; image: ImageBitmap }
  | { type: "dispose" };

export type FromWorker =
  | { type: "progress"; loaded: number; total: number }
  | { type: "ready"; precision: "f16" | "f32" }
  | { type: "result"; id: number; text: string }
  | { type: "error"; id: number | null; message: string };
