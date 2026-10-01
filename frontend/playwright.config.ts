import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

// One scratch directory per run, shared by the server and the tests.
if (!process.env.E2E_DIR) process.env.E2E_DIR = mkdtempSync(join(tmpdir(), "academia-e2e-"));
const port = Number(process.env.E2E_PORT ?? 8766);
const chromium = process.env.CHROMIUM_PATH ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1400, height: 900 },
    acceptDownloads: true,
    trace: "retain-on-failure",
    launchOptions: chromium ? { executablePath: chromium } : {},
  },
  webServer: {
    command: "bash ../scripts/e2e-server.sh",
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { E2E_DIR: process.env.E2E_DIR!, E2E_PORT: String(port) },
  },
});
