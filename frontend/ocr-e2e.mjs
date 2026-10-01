import { chromium } from "@playwright/test";
const D = "/tmp/claude-1000/-home-walter-Documents-Git-Academia/7a610d18-895f-41f5-b584-aac91d2d4b57/scratchpad/ocr-e2e";
const BASE = "http://127.0.0.1:8766";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--enable-unsafe-webgpu"] });
const ctx = await browser.newContext({ viewport: { width: 1300, height: 850 } });
await ctx.addInitScript(() => {
  localStorage.setItem("academia-recognition-enabled", "1");
  localStorage.setItem("academia-recognition-model", "light");
});
const page = await ctx.newPage();
page.on("console", (m) => { if (["error", "warning"].includes(m.type())) log("console", m.type(), m.text().slice(0, 300)); });
page.on("pageerror", (e) => log("pageerror", e.message));
page.on("worker", (w) => { log("worker started", w.url().slice(-40)); });
await page.goto(BASE + "/login");
await page.fill("#username", "admin");
await page.fill("#password", "academia-dev-pass");
await page.click("button:has-text('Sign in')");
await page.waitForSelector(".explorer");
const chooser = page.waitForEvent("filechooser");
await page.click("button:has-text('Upload')");
await (await chooser).setFiles(`${D}/ocr-test.pdf`);
await page.waitForSelector(".tile:has-text('ocr-test')", { timeout: 30000 });
log("uploaded");
await page.goto(BASE + "/settings/recognition");
const started = Date.now();
let last = "";
while (Date.now() - started < 40 * 60_000) {
  const phase = await page.locator(".device-phase").textContent().catch(() => "");
  const status = await page.evaluate(async () => (await fetch("/api/ocr/status?rank=20")).json());
  const line = `${phase?.trim()} | read ${status.read}/${status.total}`;
  if (line !== last) { log(line); last = line; }
  if (status.read >= 1) break;
  if (phase?.includes("error")) break;
  await page.waitForTimeout(5000);
}
log(`elapsed ${Math.round((Date.now() - started) / 1000)}s`);
const result = await page.evaluate(async () => (await fetch("/api/search?q=chlorophyll")).json());
log("search contents:", JSON.stringify(result.contents.map((c) => ({ name: c.name, pages: c.matches.map((m) => m.number), exact: c.matches.map((m) => m.exact) }))));
log("unread", result.unread_pages);
await page.goto(BASE + "/search?q=chlorophyll");
await page.waitForTimeout(1500);
await page.screenshot({ path: `${D}/search.png` });
await browser.close();
