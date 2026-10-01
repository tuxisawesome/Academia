/**
 * pdf.js setup. The viewer components read the core library from `globalThis.pdfjsLib`,
 * so this module must be imported before "pdfjs-dist/legacy/web/pdf_viewer.mjs".
 *
 * Only pdf.js's legacy build is used: the modern one calls JavaScript built-ins from 2025
 * (`Map.prototype.getOrInsertComputed`, `Uint8Array.prototype.toHex`, …) without polyfills,
 * so the reader would fail on any browser that is not the very latest.
 */
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

(globalThis as unknown as { pdfjsLib: typeof pdfjsLib }).pdfjsLib = pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const assetBase = import.meta.env.DEV ? "/node_modules/pdfjs-dist/" : "/pdfjs/";

export function openDocument(url: string) {
  return pdfjsLib.getDocument({
    url,
    // Fetch only the byte ranges needed for the visible pages.
    disableAutoFetch: true,
    disableStream: true,
    rangeChunkSize: 256 * 1024,
    cMapUrl: `${assetBase}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assetBase}standard_fonts/`,
    wasmUrl: `${assetBase}wasm/`,
    iccUrl: `${assetBase}iccs/`,
  });
}

export { pdfjsLib };
