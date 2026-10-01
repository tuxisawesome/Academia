/**
 * Failures of the requests pdf.js makes for a PDF (the whole file, or a byte range of it).
 * An HTTP error arrives as a `ResponseException` carrying the status; a request that got no
 * answer at all (no connection) fails with a plain error.
 */

/** The HTTP status of a failed PDF request, or 0 if the failure was not an HTTP error. */
export function responseStatus(err: unknown): number {
  const e = err as { name?: unknown; status?: unknown } | null | undefined;
  return e?.name === "ResponseException" && typeof e.status === "number" ? e.status : 0;
}

/** The proxy answers 502–504 while the server restarts; the app itself never does. */
export function serverRestarting(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

/** What to tell the reader when a PDF could not be opened. */
export function pdfErrorMessage(err: unknown): string {
  const status = responseStatus(err);
  if (status === 404) return "This PDF is no longer available. It may have been moved to the Trash.";
  if (serverRestarting(status)) return "Academia is restarting. Try again in a moment.";
  if (status >= 500) return "The server couldn't prepare this PDF. Please try again.";
  if (status) return `The PDF could not be loaded (error ${status}).`;
  const message = (err as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" && message ? message : "The PDF could not be loaded.";
}
