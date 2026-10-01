import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>("/src/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true });

describe("pdf.js", () => {
  // The modern build calls 2025 built-ins (Map.prototype.getOrInsertComputed, …) without
  // polyfills, so the reader would fail on all but the newest browsers. Mixing both builds
  // would also load pdf.js twice.
  it("is only imported from its legacy build", () => {
    const imports = Object.entries(sources).flatMap(([file, text]) =>
      [...text.matchAll(/(?:from|import)\s+["'](pdfjs-dist[^"']*)["']/g)].map((m) => `${file}: ${m[1]}`),
    );
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((line) => !line.includes(": pdfjs-dist/legacy/"))).toEqual([]);
  });
});
