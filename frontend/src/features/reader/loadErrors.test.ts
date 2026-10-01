import { describe, expect, it } from "vitest";
import { pdfErrorMessage, responseStatus, serverRestarting } from "./loadErrors";

/** What pdf.js rejects with when the server answers a PDF request with an HTTP error. */
function responseException(status: number) {
  return {
    name: "ResponseException",
    message: `Unexpected server response (${status}) while retrieving PDF "https://example.org/api/notebooks/n1/pdf?rev=3".`,
    status,
    missing: status === 404,
  };
}

describe("responseStatus", () => {
  it("reads the status of HTTP errors only", () => {
    expect(responseStatus(responseException(409))).toBe(409);
    expect(responseStatus({ name: "UnknownErrorException", message: "Failed to fetch" })).toBe(0);
    expect(responseStatus(new TypeError("Failed to fetch"))).toBe(0);
    expect(responseStatus(undefined)).toBe(0);
  });
});

describe("serverRestarting", () => {
  it("recognises the proxy's answers while the server is down", () => {
    expect([502, 503, 504].every(serverRestarting)).toBe(true);
    expect([0, 404, 409, 500].some(serverRestarting)).toBe(false);
  });
});

describe("pdfErrorMessage", () => {
  it("explains HTTP errors instead of showing pdf.js's message and URL", () => {
    expect(pdfErrorMessage(responseException(404))).toBe(
      "This PDF is no longer available. It may have been moved to the Trash.",
    );
    expect(pdfErrorMessage(responseException(503))).toBe("Academia is restarting. Try again in a moment.");
    expect(pdfErrorMessage(responseException(500))).toBe("The server couldn't prepare this PDF. Please try again.");
    expect(pdfErrorMessage(responseException(400))).toBe("The PDF could not be loaded (error 400).");
    for (const status of [400, 404, 500, 503]) expect(pdfErrorMessage(responseException(status))).not.toContain("http");
  });

  it("keeps other messages", () => {
    expect(pdfErrorMessage({ name: "InvalidPDFException", message: "Invalid PDF structure." })).toBe(
      "Invalid PDF structure.",
    );
    expect(pdfErrorMessage(null)).toBe("The PDF could not be loaded.");
    expect(pdfErrorMessage({ message: "" })).toBe("The PDF could not be loaded.");
  });
});
