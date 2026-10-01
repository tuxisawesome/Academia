import { ApiError, checkSession } from "./client";
import type { UploadedSource } from "./types";
import { checkServerVersion, reportNetworkError } from "../state/connection";

export interface UploadHandle {
  promise: Promise<UploadedSource>;
  abort: () => void;
}

/**
 * Uploads a PDF as the raw request body. XHR (not fetch) so upload progress is reported.
 * `onProgress` receives 0..1 for the transfer; the server then validates the file.
 */
export function uploadPdf(file: File, onProgress?: (fraction: number) => void): UploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<UploadedSource>((resolve, reject) => {
    xhr.open("POST", `/api/sources?filename=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader("Content-Type", "application/pdf");
    xhr.setRequestHeader("Accept", "application/json");
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      checkServerVersion(xhr.getResponseHeader("X-App-Version"));
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response as UploadedSource);
      } else {
        const err = (xhr.response && xhr.response.error) || {};
        checkSession(xhr.status, err.code);
        const message =
          err.message ||
          (xhr.status === 413 ? "This file is larger than the server allows." : `Upload failed (${xhr.status}).`);
        reject(new ApiError(xhr.status, err.code || "upload_failed", message));
      }
    };
    xhr.onerror = () => {
      reportNetworkError();
      reject(new ApiError(0, "network", "The upload failed. Check your connection."));
    };
    xhr.onabort = () => reject(new ApiError(0, "aborted", "Upload cancelled."));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}

export function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

export function baseName(filename: string): string {
  return filename.replace(/\.pdf$/i, "").trim() || "Untitled";
}
