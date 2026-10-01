import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const fixtures = join(process.env.E2E_DIR!, "fixtures");
const USER = "e2e";
const PASSWORD = "e2e-password-123";

async function signIn(page: Page) {
  await page.goto("/login");
  await page.fill("#username", USER);
  await page.fill("#password", PASSWORD);
  await page.click("button:has-text('Sign in')");
  await expect(page.locator(".explorer")).toBeVisible();
}

const tile = (page: Page, name: string) => page.locator(".tile", { hasText: name });

test.describe.serial("Academia", () => {
  test("sign-in is required and bad passwords are rejected", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
    await page.fill("#username", USER);
    await page.fill("#password", "wrong-password-1");
    await page.click("button:has-text('Sign in')");
    await expect(page.getByRole("alert")).toContainText("Incorrect username or password");
  });

  test("upload PDFs as notebooks and organise them in folders", async ({ page }) => {
    await signIn(page);
    await expect(page.getByText("Your library is empty")).toBeVisible();

    const chooser = page.waitForEvent("filechooser");
    await page.click("button:has-text('Upload')");
    await (await chooser).setFiles([join(fixtures, "Lecture Notes.pdf"), join(fixtures, "Slides.pdf")]);
    await expect(tile(page, "Lecture Notes")).toContainText("12 pages");
    await expect(tile(page, "Slides")).toContainText("4 pages");

    // New folder with inline rename.
    await page.click("button:has-text('New')");
    await page.getByRole("menuitem", { name: "Folder" }).click();
    await expect(page.locator(".rename-input")).toBeFocused();
    await page.keyboard.type("Physics");
    await page.keyboard.press("Enter");
    await expect(tile(page, "Physics")).toBeVisible();

    // Color it from the context menu.
    await tile(page, "Physics").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Color" }).click();
    await page.getByRole("menuitem", { name: "Navy" }).click();

    // Drag the notebook into the folder.
    await tile(page, "Lecture Notes").dragTo(tile(page, "Physics"));
    await expect(tile(page, "Lecture Notes")).toHaveCount(0);
    await expect(tile(page, "Physics")).toContainText("1 item");

    // List view shows the same items.
    await page.click("button[title='List view']");
    await expect(page.locator(".list-view .row", { hasText: "Slides" })).toBeVisible();
    await page.click("button[title='Grid view']");
  });

  test("select pages and create a bookmark", async ({ page }) => {
    await signIn(page);
    await tile(page, "Physics").dblclick();
    await tile(page, "Lecture Notes").dblclick();
    await expect(page.locator(".pg-tile")).toHaveCount(12);

    await page.locator('.pg-tile[data-page-index="2"]').click();
    await page.locator('.pg-tile[data-page-index="4"]').click({ modifiers: ["Shift"] });
    await page.locator('.pg-tile[data-page-index="9"]').click({ modifiers: ["Control"] });
    await expect(page.locator(".nb-toolbar")).toContainText("4 pages selected");
    await page.click(".nb-toolbar button:has-text('Bookmark')");
    await page.fill("#prompt-input", "Kinematics");
    await page.keyboard.press("Enter");
    await expect(page.locator(".nb-panel")).toContainText("Kinematics");
    await expect(page.locator(".nb-panel")).toContainText("pp. 3–5, 10");
    await expect(page.locator(".pg-markers")).toHaveCount(4);
  });

  test("insert a PDF in the middle; the bookmark grows with it", async ({ page }) => {
    await signIn(page);
    await tile(page, "Physics").dblclick();
    await tile(page, "Lecture Notes").dblclick();
    await page.locator('.pg-tile[data-page-index="3"]').click({ button: "right" });
    await page.getByRole("menuitem", { name: "Insert PDF after" }).click();
    await expect(page.getByRole("heading", { name: "Add PDF" })).toBeVisible();
    await page.locator(".dropzone input[type=file]").setInputFiles(join(fixtures, "Handout.pdf"));
    await expect(page.locator(".upload-item.ready")).toBeVisible();
    // Pages 4 and 5 are both in "Kinematics", so it is offered pre-checked.
    await expect(page.locator(".bookmark-extend")).toContainText("Kinematics");
    await expect(page.locator(".bookmark-extend input[type=checkbox]")).toBeChecked();
    await page.click("button:has-text('Add 2 pages')");
    await expect(page.locator(".pg-tile")).toHaveCount(14);
    await expect(page.locator(".nb-panel")).toContainText("pp. 3–7, 12");
  });

  test("edit a bookmark with a page range", async ({ page }) => {
    await signIn(page);
    await tile(page, "Physics").dblclick();
    await tile(page, "Kinematics").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Edit pages" }).click();
    await expect(page.locator(".pg-check.on")).toHaveCount(6);
    await page.fill("#bm-ranges", "1-2, 8-9");
    await expect(page.locator(".pg-check.on")).toHaveCount(4);
    await expect(page.locator(".chips")).toContainText("pp. 1–2");
    await page.click("button:has-text('Save bookmark')");
    await expect(tile(page, "Kinematics")).toContainText("pp. 1–2, 8–9");
  });

  test("the reader shows two pages side by side and turns pages", async ({ page }) => {
    await signIn(page);
    await tile(page, "Physics").dblclick();
    await tile(page, "Lecture Notes").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Read" }).click();
    await expect(page.locator(".pdfViewer .page canvas").first()).toBeVisible();
    await expect(page.locator(".page-indicator")).toContainText("Page 1–2");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".page-indicator")).toContainText("Page 3–4");
  });

  test("the bookmark reader shows only its pages with original numbers", async ({ page }) => {
    await signIn(page);
    await tile(page, "Physics").dblclick();
    await tile(page, "Kinematics").dblclick();
    await expect(page.locator(".pdfViewer .page canvas").first()).toBeVisible();
    await expect(page.locator(".page-indicator")).toContainText("p. 1–2");
    await expect(page.locator(".page-indicator")).toContainText("of 4");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".page-indicator")).toContainText("p. 8–9");
  });

  test("download the notebook with PDF bookmarks", async ({ page }) => {
    await signIn(page);
    await tile(page, "Physics").dblclick();
    await tile(page, "Lecture Notes").click({ button: "right" });
    const download = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "Download PDF" }).click();
    const file = await (await download).path();
    const bytes = readFileSync(file!).toString("latin1");
    expect(bytes.startsWith("%PDF")).toBe(true);
    expect(bytes).toContain("/Outlines");
    expect(bytes).toContain("Kinematics");
  });

  test("trash and restore", async ({ page }) => {
    await signIn(page);
    await tile(page, "Slides").click();
    await page.keyboard.press("Delete");
    await expect(tile(page, "Slides")).toHaveCount(0);
    await page.goto("/trash");
    await page.locator(".row", { hasText: "Slides" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Restore" }).click();
    await page.goto("/");
    await expect(tile(page, "Slides")).toBeVisible();
  });

  test("phones get one page at a time", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    await signIn(page);
    await tile(page, "Slides").tap();
    await expect(page).toHaveURL(/\/n\//);
    await page.click("button:has-text('Read')");
    await expect(page.locator(".pdfViewer .page canvas").first()).toBeVisible();
    await expect(page.locator(".page-indicator")).toContainText("Page 1");
    await expect(page.locator(".page-indicator")).not.toContainText("1–2");
    await context.close();
  });

  test("offline: the app shows the connect-and-retry page", async ({ page, context }) => {
    await signIn(page);
    // Wait for the service worker to take control, then go offline.
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve));
      }
      return reg.active?.state;
    });
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
    await context.setOffline(false);
    await page.getByRole("link", { name: "Try again" }).click();
    await expect(page.locator(".explorer")).toBeVisible();

    // Losing the connection while the app is open shows a blocking overlay.
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await expect(page.getByRole("alertdialog")).toContainText("You're offline");
    await context.setOffline(false);
    // It retries on its own once the connection is back.
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  });
});
