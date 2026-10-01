import { cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const PDFJS_DIRS = ["cmaps", "standard_fonts", "wasm", "iccs"];


/** Copies pdf.js runtime assets (CMaps, standard fonts, wasm decoders, ICC profiles) into dist/pdfjs. */
function pdfjsAssets(): Plugin {
  return {
    name: "academia-pdfjs-assets",
    apply: "build",
    writeBundle(options) {
      const outDir = options.dir ?? resolve(import.meta.dirname, "dist");
      for (const dir of PDFJS_DIRS) {
        const from = resolve(import.meta.dirname, "node_modules/pdfjs-dist", dir);
        if (existsSync(from)) cpSync(from, resolve(outDir, "pdfjs", dir), { recursive: true });
      }

    },
  };
}

const backend = process.env.ACADEMIA_BACKEND ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react(), pdfjsAssets()],
  define: {
    __APP_BUILD__: JSON.stringify(process.env.ACADEMIA_BUILD_ID ?? "dev"),
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: backend, changeOrigin: false },
    },
  },
  worker: {
    format: "es",
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
} as Parameters<typeof defineConfig>[0]);
