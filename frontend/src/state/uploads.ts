import { create } from "zustand";
import { api, errorMessage } from "../api/client";
import { createNotebook } from "../api/actions";
import { invalidateLibrary, queryClient } from "../api/queries";
import { baseName, isPdfFile, uploadPdf } from "../api/upload";
import type { NotebookDetail } from "../api/types";
import { toast } from "./toasts";

export interface UploadItem {
  id: number;
  name: string;
  progress: number;
  status: "uploading" | "processing" | "done" | "error";
  error?: string;
  abort?: () => void;
}

interface UploadState {
  items: UploadItem[];
  add: (item: UploadItem) => void;
  update: (id: number, patch: Partial<UploadItem>) => void;
  clearFinished: () => void;
}

export const useUploads = create<UploadState>((set) => ({
  items: [],
  add: (item) => set((s) => ({ items: [...s.items, item] })),
  update: (id, patch) => set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) })),
  clearFinished: () => set((s) => ({ items: s.items.filter((i) => i.status === "uploading" || i.status === "processing") })),
}));

let nextId = 1;

async function runUpload(file: File, after: (sourceId: string) => Promise<void>) {
  const id = nextId++;
  const store = useUploads.getState();
  const handle = uploadPdf(file, (p) => {
    useUploads.getState().update(id, { progress: p, status: p >= 1 ? "processing" : "uploading" });
  });
  store.add({ id, name: file.name, progress: 0, status: "uploading", abort: handle.abort });
  try {
    const source = await handle.promise;
    useUploads.getState().update(id, { status: "processing", progress: 1 });
    await after(source.id);
    useUploads.getState().update(id, { status: "done", abort: undefined });
  } catch (err) {
    useUploads.getState().update(id, { status: "error", error: errorMessage(err), abort: undefined });
  }
}

function pdfsOnly(files: File[]): File[] {
  const pdfs = files.filter(isPdfFile);
  const skipped = files.length - pdfs.length;
  if (skipped > 0) toast(`${skipped === 1 ? "One file was" : `${skipped} files were`} skipped — only PDFs can be added.`);
  return pdfs;
}

/** Each PDF becomes a new notebook in `folderId`. */
export async function uploadAsNotebooks(files: File[], folderId: string | null): Promise<void> {
  const pdfs = pdfsOnly(files);
  await Promise.all(
    pdfs.map((file) =>
      runUpload(file, async (sourceId) => {
        await createNotebook(folderId, baseName(file.name), sourceId);
      }),
    ),
  );
  if (pdfs.length) await invalidateLibrary();
}

/** Appends each PDF (in order) to the end of an existing notebook. */
export async function appendToNotebook(files: File[], notebookId: string): Promise<void> {
  const pdfs = pdfsOnly(files);
  for (const file of pdfs) {
    await runUpload(file, async (sourceId) => {
      const detail = await api<NotebookDetail>(`/notebooks/${notebookId}/pages/insert`, {
        method: "POST",
        json: { base_rev: null, source_id: sourceId, at: "end" },
      });
      queryClient.setQueryData(["notebook", notebookId], detail);
    });
  }
  if (pdfs.length) await invalidateLibrary();
}
