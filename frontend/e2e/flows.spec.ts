import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const fixtures = join(process.env.E2E_DIR!, "fixtures");

async function signIn(page: Page, user = "e2e", password = "e2e-password-123") {
  await page.goto("/login");
  await page.fill("#username", user);
  await page.fill("#password", password);
  await page.click("button:has-text('Sign in')");
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

const tile = (page: Page, name: string) => page.locator(".tile", { hasText: name });

test.describe.serial("More flows", () => {
  test("new empty notebook, then add a PDF to it", async ({ page }) => {
    await signIn(page);
    await page.click("button:has-text('New')");
    await page.getByRole("menuitem", { name: "Notebook" }).click();
    await page.fill("#prompt-input", "Seminar Reader");
    await page.click("button:has-text('Create')");
    await expect(page.getByRole("heading", { name: "Add PDF" })).toBeVisible();
    await page.locator(".dropzone input[type=file]").setInputFiles(join(fixtures, "Handout.pdf"));
    await page.click("button:has-text('Add 2 pages')");
    await expect(page.locator(".pg-tile")).toHaveCount(2);
    await expect(page.locator(".nb-title")).toContainText("2 pages");
  });

  test("new bookmark from the library menu", async ({ page }) => {
    await signIn(page);
    await page.click("button:has-text('New')");
    await page.getByRole("menuitem", { name: "Bookmark…" }).click();
    await page.locator(".notebook-choice", { hasText: "Seminar Reader" }).click();
    await expect(page.getByRole("heading", { name: "New bookmark" })).toBeVisible();
    await page.fill("#bm-name", "Handout page 2");
    await page.fill("#bm-ranges", "2");
    await page.click("button:has-text('Save bookmark')");
    await expect(tile(page, "Handout page 2")).toContainText("p. 2");
  });

  test("properties and move-to dialogs", async ({ page }) => {
    await signIn(page);
    await tile(page, "Seminar Reader").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Properties" }).click();
    await expect(page.getByRole("dialog")).toContainText("Notebook");
    await expect(page.getByRole("dialog")).toContainText("2");
    await page.getByRole("button", { name: "Done" }).click();

    await tile(page, "Handout page 2").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move to…" }).click();
    await page.getByRole("treeitem", { name: "Physics" }).click();
    await page.click("button:has-text('Move here')");
    await expect(tile(page, "Handout page 2")).toHaveCount(0);
    await tile(page, "Physics").dblclick();
    await expect(tile(page, "Handout page 2")).toBeVisible();
  });

  test("theme can be switched and is remembered", async ({ page }) => {
    await signIn(page);
    await page.goto("/settings/appearance");
    await page.getByLabel("Dark").check();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByLabel("Match device").check();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
  });

  test("admin adds a user who must choose a password", async ({ page, browser }) => {
    await signIn(page);
    await page.goto("/admin/users");
    await page.click("button:has-text('Add user')");
    await page.fill("#nu-username", "student");
    await page.fill("#nu-password", "first-temp-pass-1");
    await page.click("button:has-text('Create user')");
    await expect(page.locator(".ut-row", { hasText: "student" })).toContainText("Pending password");

    const other = await browser.newContext();
    const p2 = await other.newPage();
    await signIn(p2, "student", "first-temp-pass-1");
    await expect(p2.getByRole("heading", { name: "Choose your password" })).toBeVisible();
    await p2.fill("#pw-current", "first-temp-pass-1");
    await p2.fill("#pw-new", "my-own-password-1");
    await p2.fill("#pw-confirm", "my-own-password-1");
    await p2.click("button:has-text('Save password')");
    await expect(p2.getByText("Your library is empty")).toBeVisible();
    await other.close();
  });
});
