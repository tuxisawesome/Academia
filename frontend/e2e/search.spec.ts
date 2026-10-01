import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const fixtures = join(process.env.E2E_DIR!, "fixtures");

async function signIn(page: Page) {
  await page.goto("/login");
  await page.fill("#username", "e2e");
  await page.fill("#password", "e2e-password-123");
  await page.click("button:has-text('Sign in')");
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

const tile = (page: Page, name: string) => page.locator(".tile", { hasText: name });

test.describe.serial("Pinned folders and search", () => {
  test("pin folders from the context menu and by dragging, reorder and unpin", async ({ page }) => {
    await signIn(page);
    await page.goto("/");
    for (const name of ["Chemistry", "Biology"]) {
      await page.click("button:has-text('New')");
      await page.getByRole("menuitem", { name: "Folder" }).click();
      await expect(page.locator(".rename-input")).toBeFocused();
      await page.keyboard.type(name);
      await page.keyboard.press("Enter");
      await expect(tile(page, name)).toBeVisible();
    }
    const pinned = page.locator(".pinned-list");
    await tile(page, "Chemistry").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Pin to sidebar" }).click();
    await expect(pinned.locator(".pin-item")).toHaveText(["Chemistry"]);

    // Drag a folder onto the "Pinned" heading to pin it.
    await tile(page, "Biology").dragTo(page.locator(".pinned-head"));
    await expect(pinned.locator(".pin-item")).toHaveText(["Chemistry", "Biology"]);

    // Reorder from the pin's menu, then open it.
    await pinned.locator(".pin-item", { hasText: "Biology" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move up" }).click();
    await expect(pinned.locator(".pin-item")).toHaveText(["Biology", "Chemistry"]);
    await pinned.getByRole("link", { name: "Chemistry" }).click();
    await expect(page).toHaveURL(/\/f\//);
    await expect(page.locator(".breadcrumbs")).toContainText("Chemistry");

    // Pins survive a reload (stored on the server).
    await page.reload();
    await expect(pinned.locator(".pin-item")).toHaveText(["Biology", "Chemistry"]);

    await pinned.locator(".pin-item", { hasText: "Biology" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Unpin from sidebar" }).click();
    await expect(pinned.locator(".pin-item")).toHaveText(["Chemistry"]);
  });

  test("search is scoped to the open folder and split into Files and Contents", async ({ page }) => {
    await signIn(page);
    await page.locator(".pinned-list").getByRole("link", { name: "Chemistry" }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.click("button:has-text('Upload')");
    await (await chooser).setFiles(join(fixtures, "Lecture Notes.pdf"));
    await expect(tile(page, "Lecture Notes")).toBeVisible();

    const box = page.getByRole("searchbox");
    await expect(box).toHaveAttribute("placeholder", "Search “Chemistry”");
    await box.fill("lecture 7");
    await expect(page).toHaveURL(/\/search\?q=lecture\+7&in=/);
    await expect(page.locator(".scope-chip")).toContainText("in Chemistry and its subfolders");

    const files = page.locator(".search-section", { hasText: "Files" });
    const contents = page.locator(".search-section", { hasText: "Contents" });
    await expect(files.locator(".list-view .row:not(.head)")).toHaveText([/Lecture Notes/]);
    // Typed text is indexed in the background right after upload.
    await expect
      .poll(async () => {
        await page.reload();
        return contents.locator(".content-hit").count();
      }, { timeout: 30_000 })
      .toBe(1);
    await expect(contents.locator(".hit-page")).toHaveText([/p\. 7/]);

    // Sections collapse.
    await files.locator(".section-toggle").click();
    await expect(files.locator(".section-body")).toHaveCount(0);
    await files.locator(".section-toggle").click();

    // Searching everywhere from a different folder doesn't find it.
    await page.goto("/");
    await page.locator(".tile", { hasText: "Biology" }).dblclick();
    await box.fill("lecture 7");
    await expect(page.locator(".scope-chip")).toContainText("Biology");
    await expect(page.locator(".search-section", { hasText: "Contents" })).toContainText("No pages mention");
    await page.locator(".scope-chip").getByTitle("Search everywhere").click();
    await expect(page.locator(".scope-chip")).toContainText("in your whole library");
    await expect(page.locator(".content-hit")).toHaveCount(1);

    // Clicking a page opens the reader there.
    await page.locator(".hit-page").first().click();
    await expect(page).toHaveURL(/\/read\/n\/.+\?page=7/);
    await expect(page.locator(".page-indicator")).toContainText("7");
  });
});
