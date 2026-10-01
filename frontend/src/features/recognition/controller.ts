/**
 * Runs handwriting recognition in this browser while Academia is open.
 *
 * Loop: ask the server for a few unread pages ("claim"), render each page from the
 * original PDF with pdf.js, run the recognition model in a Web Worker (WebGPU), and send
 * the text back ("submit"). Only one tab per browser does this (Web Locks API); the
 * server leases claimed pages so several devices can share the work.
 */
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { api, ApiError } from "../../api/client";
import { queryClient } from "../../api/queries";
import type { ReadingStatus } from "../../api/types";
import { openDocument } from "../reader/pdfjs";
import { currentEngine, PROMPT } from "./engine";
import type { FromWorker, ToWorker } from "./protocol";
import { defaultEnabled, deviceId, storedEnabled, storeEnabled, useRecognition } from "./store";

interface ClaimedPage {
  source_id: string;
  index: number;
  rotation: number;
  width: number;
  height: number;
}

const LOCK = "academia-recognition";
const IDLE_WAIT_MS = 2 * 60_000;
const BATCH = 4;

function sleep(ms: number, signal: { wake?: () => void }): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.wake = () => {
      clearTimeout(t);
      resolve();
    };
  });
}

export async function webgpuAvailable(): Promise<boolean> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

class RecognitionController {
  private worker: Worker | null = null;
  private pending = new Map<number, { resolve: (text: string) => void; reject: (err: Error) => void }>();
  private nextId = 1;
  private running = false;
  private stopRequested = false;
  private releaseLock: (() => void) | null = null;
  private idle: { wake?: () => void } = {};
  private failures = 0;
  private docs = new Map<string, { task: PDFDocumentLoadingTask; doc: PDFDocumentProxy }>();
  supported: boolean | null = null;

  get enabled(): boolean {
    return storedEnabled() ?? defaultEnabled();
  }

  async init(): Promise<void> {
    const store = useRecognition.getState();
    if (this.supported === null) {
      store.set({ phase: "checking" });
      this.supported = await webgpuAvailable();
    }
    if (!this.supported) return store.set({ phase: "unsupported" });
    if (!this.enabled) return store.set({ phase: "off" });
    this.start();
  }

  setEnabled(enabled: boolean): void {
    storeEnabled(enabled);
    if (enabled) void this.init();
    else {
      this.stop();
      useRecognition.getState().set({ phase: "off" });
    }
  }

  /** Switch model: stop and start again with the newly chosen engine. */
  restart(): void {
    this.stop();
    const wait = () => (this.running ? setTimeout(wait, 200) : void this.init());
    wait();
  }

  /** Something new may need reading (e.g. an upload finished). */
  poke(): void {
    this.idle.wake?.();
  }

  private start(): void {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    const run = async () => {
      try {
        await this.loop();
        this.failures = 0;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          useRecognition.getState().set({ phase: "off" }); // signed out
        } else {
          useRecognition.getState().set({ phase: "error", error: (err as Error).message || String(err) });
          this.scheduleRetry();
        }
      } finally {
        this.running = false;
        this.disposeWorker();
      }
    };
    const locks = (navigator as unknown as { locks?: LockManager }).locks;
    if (!locks) {
      void run();
      return;
    }
    void locks.request(LOCK, { ifAvailable: true }, async (lock) => {
      if (!lock) {
        this.running = false;
        useRecognition.getState().set({ phase: "other-tab" });
        // Try again later, e.g. after the other tab is closed.
        setTimeout(() => this.enabled && void this.init(), 60_000);
        return;
      }
      await new Promise<void>((resolve) => {
        this.releaseLock = resolve;
        void run().finally(resolve);
      });
      this.releaseLock = null;
    });
  }

  /** Try again after a failure, waiting longer each time (1, 5, then 30 minutes). */
  private scheduleRetry(): void {
    const delays = [60_000, 5 * 60_000, 30 * 60_000];
    const delay = delays[Math.min(this.failures, delays.length - 1)];
    this.failures++;
    setTimeout(() => {
      if (this.enabled && !this.running && !this.stopRequested) void this.init();
    }, delay);
  }

  stop(): void {
    this.stopRequested = true;
    this.idle.wake?.();
    this.disposeWorker();
    this.releaseLock?.();
  }

  private async refreshStatus(): Promise<ReadingStatus | null> {
    try {
      const status = await api<ReadingStatus>("/ocr/status", { query: { rank: currentEngine().rank } });
      useRecognition.getState().set({ server: status });
      queryClient.setQueryData(["ocr-status"], status);
      return status;
    } catch {
      return null;
    }
  }

  private ensureWorker(): Promise<void> {
    if (this.worker) return Promise.resolve();
    const store = useRecognition.getState();
    store.set({ phase: "loading", loaded: 0, total: 0, error: null });
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      this.worker = worker;
      worker.onmessage = (event: MessageEvent<FromWorker>) => {
        const msg = event.data;
        if (msg.type === "progress") store.set({ loaded: msg.loaded, total: msg.total });
        else if (msg.type === "ready") resolve();
        else if (msg.type === "result") {
          this.pending.get(msg.id)?.resolve(msg.text);
          this.pending.delete(msg.id);
        } else if (msg.type === "error") {
          if (msg.id === null) reject(new Error(msg.message));
          else {
            this.pending.get(msg.id)?.reject(new Error(msg.message));
            this.pending.delete(msg.id);
          }
        }
      };
      worker.onerror = (event) => reject(new Error(event.message || "The handwriting reader failed to start."));
      const engine = currentEngine();
      worker.postMessage({ type: "load", repo: engine.repo, revision: engine.revision, prompt: PROMPT } satisfies ToWorker);
    });
  }

  private disposeWorker(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    for (const p of this.pending.values()) p.reject(new Error("stopped"));
    this.pending.clear();
    for (const { task } of this.docs.values()) void task.destroy();
    this.docs.clear();
  }

  private recognize(image: ImageBitmap): Promise<string> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ type: "recognize", id, image } satisfies ToWorker, [image]);
    });
  }

  private async document(sourceId: string): Promise<PDFDocumentProxy> {
    let entry = this.docs.get(sourceId);
    if (!entry) {
      const task = openDocument(`/api/sources/${sourceId}/file`);
      entry = { task, doc: await task.promise };
      this.docs.set(sourceId, entry);
      // Keep only a few documents open.
      while (this.docs.size > 3) {
        const [oldest, old] = this.docs.entries().next().value!;
        this.docs.delete(oldest);
        void old.task.destroy();
      }
    }
    return entry.doc;
  }

  private async render(page: ClaimedPage): Promise<ImageBitmap> {
    const doc = await this.document(page.source_id);
    const pdfPage = await doc.getPage(page.index + 1);
    const rotation = (pdfPage.rotate + page.rotation) % 360;
    const base = pdfPage.getViewport({ scale: 1, rotation });
    const scale = Math.min(currentEngine().maxSide / Math.max(base.width, base.height), 4);
    const viewport = pdfPage.getViewport({ scale, rotation });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await pdfPage.render({ canvas, canvasContext: ctx, viewport }).promise;
    pdfPage.cleanup();
    const bitmap = await createImageBitmap(canvas);
    canvas.width = canvas.height = 0;
    return bitmap;
  }

  private async loop(): Promise<void> {
    const store = useRecognition.getState();
    const device = deviceId();
    const engine = currentEngine();
    // Ask the browser not to evict the (large) cached model files.
    void navigator.storage?.persist?.().catch(() => undefined);
    let status = await this.refreshStatus();
    while (!this.stopRequested) {
      if (status && status.remaining === 0) {
        store.set({ phase: "idle" });
        await sleep(IDLE_WAIT_MS, this.idle);
        status = await this.refreshStatus();
        continue;
      }
      const { pages } = await api<{ pages: ClaimedPage[] }>("/ocr/claim", {
        method: "POST",
        json: { device, engine: engine.id, rank: engine.rank, limit: BATCH },
      });
      if (pages.length === 0) {
        store.set({ phase: "idle" });
        await sleep(IDLE_WAIT_MS, this.idle);
        status = await this.refreshStatus();
        continue;
      }
      await this.ensureWorker();
      store.set({ phase: "reading" });
      const items: { source_id: string; index: number; text?: string; error?: string }[] = [];
      for (const page of pages) {
        if (this.stopRequested) break;
        try {
          const image = await this.render(page);
          const text = await this.recognize(image);
          items.push({ source_id: page.source_id, index: page.index, text });
          store.set({ readThisSession: useRecognition.getState().readThisSession + 1 });
        } catch (err) {
          if (this.stopRequested) break;
          items.push({ source_id: page.source_id, index: page.index, error: String((err as Error).message || err) });
        }
      }
      if (items.length) {
        await api("/ocr/submit", {
          method: "POST",
          json: { device, engine: engine.id, rank: engine.rank, items },
        });
        void queryClient.invalidateQueries({ queryKey: ["search"] });
      }
      status = await this.refreshStatus();
    }
  }
}

export const recognition = new RecognitionController();
