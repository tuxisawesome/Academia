/// <reference lib="webworker" />
/**
 * Handwriting recognition worker: runs a Qwen3.5 vision-language model with
 * transformers.js on WebGPU. Model files come from Academia's own mirror (/api/models/…)
 * and are cached by the browser (Cache API), so they're downloaded once per browser.
 */
import {
  AutoModelForImageTextToText,
  AutoProcessor,
  env,
  RawImage,
  type Tensor,
} from "@huggingface/transformers";
import ortMjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import type { FromWorker, ToWorker } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.remoteHost = new URL("/api/models/", self.location.origin).href;
env.remotePathTemplate = "{model}/resolve/{revision}/";
env.useBrowserCache = true;
// Load the ONNX Runtime glue as a normal module (the app's CSP doesn't allow blob: scripts).
env.useWasmCache = false;
env.backends.onnx.wasm!.wasmPaths = {
  mjs: new URL(ortMjsUrl, self.location.origin).href,
  wasm: new URL(ortWasmUrl, self.location.origin).href,
};

type Loaded = {
  processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>;
  model: Awaited<ReturnType<typeof AutoModelForImageTextToText.from_pretrained>>;
};

let loaded: Loaded | null = null;
let prompt = "";

function post(msg: FromWorker): void {
  self.postMessage(msg);
}

async function load(repo: string, revision: string): Promise<"f16" | "f32"> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("WebGPU isn't available in this browser.");
  const f16 = adapter.features.has("shader-f16");
  const dtype = f16
    ? ({ embed_tokens: "q4f16", vision_encoder: "fp16", decoder_model_merged: "q4f16" } as const)
    : ({ embed_tokens: "q4", vision_encoder: "fp32", decoder_model_merged: "q4" } as const);

  // Aggregate per-file download progress into one number.
  const files = new Map<string, { loaded: number; total: number }>();
  const progress_callback = (p: { status?: string; file?: string; loaded?: number; total?: number }) => {
    if (p.status !== "progress" || !p.file) return;
    files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
    let sumLoaded = 0;
    let sumTotal = 0;
    for (const f of files.values()) {
      sumLoaded += f.loaded;
      sumTotal += f.total;
    }
    post({ type: "progress", loaded: sumLoaded, total: sumTotal });
  };

  const processor = await AutoProcessor.from_pretrained(repo, { revision });
  const model = await AutoModelForImageTextToText.from_pretrained(repo, {
    revision,
    device: "webgpu",
    dtype,
    progress_callback,
  });
  loaded = { processor, model };
  return f16 ? "f16" : "f32";
}

async function recognize(bitmap: ImageBitmap): Promise<string> {
  if (!loaded) throw new Error("The model isn't loaded yet.");
  const { processor, model } = loaded;
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const image = new RawImage(data.data, data.width, data.height, 4).rgb();

  const messages = [{ role: "user", content: [{ type: "image" }, { type: "text", text: prompt }] }];
  const text = processor.apply_chat_template(messages, { add_generation_prompt: true });
  const inputs = await processor(text, image);
  const output = (await model.generate({
    ...inputs,
    max_new_tokens: 2048,
    do_sample: false,
    repetition_penalty: 1.05,
  })) as Tensor;
  const [decoded] = processor.batch_decode(output.slice(null, [inputs.input_ids.dims.at(-1), null]), {
    skip_special_tokens: true,
  });
  return decoded.trim();
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  if (msg.type === "load") {
    try {
      prompt = msg.prompt;
      const precision = await load(msg.repo, msg.revision);
      post({ type: "ready", precision });
    } catch (err) {
      post({ type: "error", id: null, message: (err as Error).message || String(err) });
    }
  } else if (msg.type === "recognize") {
    try {
      post({ type: "result", id: msg.id, text: await recognize(msg.image) });
    } catch (err) {
      post({ type: "error", id: msg.id, message: (err as Error).message || String(err) });
    }
  } else if (msg.type === "dispose") {
    await loaded?.model.dispose?.();
    loaded = null;
  }
};
