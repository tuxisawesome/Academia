/**
 * pdf.js setup. The viewer components read the core library from `globalThis.pdfjsLib`,
 * so this module must be imported before "pdfjs-dist/web/pdf_viewer.mjs".
 */
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

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
