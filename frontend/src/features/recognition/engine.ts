/**
 * The handwriting-recognition models a browser can run. Qwen3.5 vision-language models
 * (Apache-2.0) via transformers.js on WebGPU, one whole page per call.
 *
 * Each engine has a quality rank: the server only lets a page be re-read by a better
 * engine, so a page read on a weaker device is upgraded later by a stronger one.
 * Repositories and revisions must match ALLOWED_MODELS in backend/academia/services/modelfiles.py.
 */

export interface EngineSpec {
  key: "standard" | "light";
  id: string;
  rank: number;
  label: string;
  repo: string;
  revision: string;
  /** Approximate download with half-precision weights. */
  downloadMB: number;
  /** Longest side of the rendered page, in pixels (~2 MP for a letter-size page). */
  maxSide: number;
}

export const ENGINES: Record<EngineSpec["key"], EngineSpec> = {
  standard: {
    key: "standard",
    id: "qwen3.5-2b@2ea7886",
    rank: 30,
    label: "Qwen3.5 2B — handwriting-capable vision model",
    repo: "onnx-community/Qwen3.5-2B-ONNX-OPT",
    revision: "2ea7886f48b926aca97de8b0e041ffca7e3ebaa9",
    downloadMB: 2070,
    maxSide: 1600,
  },
  light: {
    key: "light",
    id: "qwen3.5-0.8b@fafab72",
    rank: 20,
    label: "Qwen3.5 0.8B — lighter, for smaller graphics cards",
    repo: "onnx-community/Qwen3.5-0.8B-ONNX-OPT",
    revision: "fafab72d87a9e6be3925b38caf48286d2838f2d0",
    downloadMB: 810,
    maxSide: 1600,
  },
};

export const PROMPT =
  "Transcribe all text on this page verbatim, both printed and handwritten, in reading order. " +
  "Output plain text only, no commentary. Write math in LaTeX. If a word is hard to read, give your best guess.";

const TIER_KEY = "academia-recognition-model";

export type TierChoice = "auto" | EngineSpec["key"];

export function storedTier(): TierChoice {
  try {
    const v = localStorage.getItem(TIER_KEY);
    return v === "standard" || v === "light" ? v : "auto";
  } catch {
    return "auto";
  }
}

export function storeTier(tier: TierChoice): void {
  try {
    if (tier === "auto") localStorage.removeItem(TIER_KEY);
    else localStorage.setItem(TIER_KEY, tier);
  } catch {
    /* ignore */
  }
}

/** The engine this device uses: the larger model unless the device reports little memory. */
export function currentEngine(): EngineSpec {
  const tier = storedTier();
  if (tier !== "auto") return ENGINES[tier];
  const memory = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
  return memory !== undefined && memory < 8 ? ENGINES.light : ENGINES.standard;
}
