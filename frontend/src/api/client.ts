import { checkServerVersion, reportNetworkError, reportServerUnavailable } from "../state/connection";

export class ApiError extends Error {
  status: number;
  code: string;
  data: Record<string, unknown>;

  constructor(status: number, code: string, message: string, data: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  query?: Record<string, string | number | boolean | null | undefined>;
}

export function apiUrl(path: string, query?: RequestOptions["query"]): string {
  const url = new URL(`/api${path}`, window.location.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url.pathname + url.search;
}

async function errorFrom(res: Response): Promise<ApiError> {
  let code = "http_error";
  let message = `Request failed (${res.status}).`;
  let data: Record<string, unknown> = {};
  try {
    const body = await res.json();
    if (body?.error) {
      const { code: c, message: m, ...rest } = body.error;
      code = c ?? code;
      message = m ?? message;
      data = rest;
    } else if (body?.detail) {
      message = typeof body.detail === "string" ? body.detail : message;
    }
  } catch {
    /* not JSON */
  }
  return new ApiError(res.status, code, message, data);
}

export async function api<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", json, body, headers = {}, signal, query } = options;
  let res: Response;
  try {
    res = await fetch(apiUrl(path, query), {
      method,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: json !== undefined ? JSON.stringify(json) : body,
      signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    reportNetworkError();
    throw new ApiError(0, "network", "Can't reach the server. Check your internet connection.");
  }
  checkServerVersion(res.headers.get("X-App-Version"));
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    if (!res.headers.get("X-App-Version")) reportServerUnavailable();
  }
  if (!res.ok) throw await errorFrom(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function thumbUrl(sourceId: string, index: number, width = 400): string {
  return `/api/thumbs/${sourceId}/${index}?w=${width}`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

/** Starts a file download from a same-origin URL (the server sets Content-Disposition). */
export function downloadUrl(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
