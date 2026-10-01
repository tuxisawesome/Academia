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
const pageTile = (page: Page, index: number) => page.locator(`.pg-tile[data-page-index="${index}"]`);

// The specs share one library: this one works in a folder of its own, with names no other spec uses.
const FOLDER = "Tag Course";
const BOOKMARK = "Tag Course Week 2";

async function openNotebook(page: Page) {
  await page.goto("/");
  await tile(page, FOLDER).dblclick();
  await tile(page, "Lecture Notes").dblclick();
  await expect(page.locator(".pg-tile")).toHaveCount(12);
}

test.describe.serial("Class and date tags", () => {
  test("classes are kept in Settings", async ({ page }) => {
    await signIn(page);
    await page.goto("/settings/classes");
    const list = page.locator(".class-list li");

    await page.fill("#new-class", "Organic Chemistry");
    await page.keyboard.press("Enter");
    await expect(list).toHaveText([/Organic Chemistry/]);
    for (const name of ["Thermodynamics", "Économie"]) {
      await page.fill("#new-class", name);
      await page.click("button:has-text('Add class')");
      await expect(list.last()).toContainText(name);
    }
    await expect(list).toHaveCount(3);

    // Names are unique whatever their case.
    await page.fill("#new-class", "organic chemistry");
    await page.keyboard.press("Enter");
    await expect(page.locator(".settings-card .form-error")).toContainText(/already have a class/i);
    await expect(list).toHaveCount(3);

    // Reorder, color and rename.
    await page.getByRole("button", { name: "Move Économie up" }).click();
    await expect(list.locator(".class-name")).toHaveText(["Organic Chemistry", "Économie", "Thermodynamics"]);
    await page.getByRole("button", { name: "Color of Organic Chemistry" }).click();
    await page.getByRole("menuitem", { name: "Navy" }).click();
    await page.getByRole("button", { name: "Rename Économie" }).click();
    await page.getByLabel("New name for Économie").fill("Économie politique");
    await page.keyboard.press("Enter");
    await expect(list.locator(".class-name")).toHaveText(["Organic Chemistry", "Économie politique", "Thermodynamics"]);

    // Kept on the server.
    await page.reload();
    await expect(list.locator(".class-name")).toHaveText(["Organic Chemistry", "Économie politique", "Thermodynamics"]);
    await expect(list.first()).toContainText("0 pages");
  });

  test("tag selected pages with the searchable class dropdown", async ({ page }) => {
    await signIn(page);
    await page.click("button:has-text('New')");
    await page.getByRole("menuitem", { name: "Folder" }).click();
    await expect(page.locator(".rename-input")).toBeFocused();
    await page.keyboard.type(FOLDER);
    await page.keyboard.press("Enter");
    await tile(page, FOLDER).dblclick();
    const chooser = page.waitForEvent("filechooser");
    await page.click("button:has-text('Upload')");
    await (await chooser).setFiles(join(fixtures, "Lecture Notes.pdf"));
    await expect(tile(page, "Lecture Notes")).toContainText("12 pages");
    await tile(page, "Lecture Notes").dblclick();
    await expect(page.locator(".pg-tile")).toHaveCount(12);

    // Pages 3–5.
    await pageTile(page, 2).click();
    await pageTile(page, 4).click({ modifiers: ["Shift"] });
    await page.getByRole("button", { name: "Tag pages", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Tag 3 pages" })).toBeVisible();
    await dialog.locator("#tag-date").fill("2026-03-05");

    // The dropdown filters as you type, ignoring case and accents.
    const picker = dialog.getByRole("combobox", { name: "Add a class" });
    const list = page.getByRole("listbox", { name: "Add a class" });
    await picker.fill("orga");
    // Matching classes come first (Enter picks the highlighted one); a new class can still be added.
    await expect(list.getByRole("option")).toHaveText(["Organic Chemistry", "Add class “orga”"]);
    await page.keyboard.press("Enter");
    await picker.fill("econ");
    await expect(list.getByRole("option", { name: "Économie politique" })).toBeVisible();
    await page.keyboard.press("Enter");
    // A class that doesn't exist yet can be added from here.
    await picker.fill("Lab Safety");
    await list.getByRole("option", { name: "Add class “Lab Safety”" }).click();
    await expect(dialog.locator(".tag-chips .class-chip")).toHaveText([
      "Organic Chemistry",
      "Économie politique",
      "Lab Safety",
    ]);
    // Esc closes the list, not the dialog.
    await picker.fill("thermo");
    await expect(list).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(list).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await picker.fill("");
    await dialog.getByRole("button", { name: "Remove Lab Safety" }).click();
    await dialog.getByRole("button", { name: "Save tags" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".toast")).toContainText("Tagged 3 pages.");

    // Thumbnails show the tags.
    for (const index of [2, 3, 4]) {
      await expect(pageTile(page, index).locator(".pg-tags")).toHaveAttribute("title", /Organic Chemistry, Économie politique/);
    }
    await expect(pageTile(page, 1).locator(".pg-tags")).toHaveCount(0);

    // Pages 5–6, of which only 5 is tagged: the date is mixed and the classes are on some pages.
    await pageTile(page, 4).click();
    await pageTile(page, 5).click({ modifiers: ["Shift"] });
    await page.locator(".nb-grid-wrap .page-grid").press("t");
    await expect(dialog.getByRole("heading", { name: "Tag 2 pages" })).toBeVisible();
    await expect(dialog).toContainText("Mixed");
    await expect(dialog.locator("#tag-date")).toHaveValue("");
    const partial = dialog.locator(".class-chip.partial", { hasText: "Organic Chemistry" });
    await expect(partial).toBeVisible();
    await partial.locator(".chip-label").click();
    await expect(dialog.locator(".class-chip.partial", { hasText: "Organic Chemistry" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Save tags" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(pageTile(page, 5).locator(".pg-tags")).toHaveAttribute("title", "Organic Chemistry");
    // Page 5 kept its date and its other class.
    await expect(pageTile(page, 4).locator(".pg-tags")).toHaveAttribute("title", /Organic Chemistry, Économie politique/);

    // The page count in Settings follows.
    await page.goto("/settings/classes");
    await expect(page.locator(".class-list li", { hasText: "Organic Chemistry" })).toContainText("4 pages");
  });

  test("tag pages through a bookmark", async ({ page }) => {
    await signIn(page);
    await openNotebook(page);
    await pageTile(page, 7).click();
    await pageTile(page, 8).click({ modifiers: ["Shift"] });
    await page.click(".nb-toolbar button:has-text('Bookmark')");
    await page.fill("#prompt-input", BOOKMARK);
    await page.keyboard.press("Enter");
    await expect(page.locator(".nb-panel")).toContainText(BOOKMARK);

    // From the bookmark's menu in its folder.
    await page.goto("/");
    await tile(page, FOLDER).dblclick();
    await tile(page, BOOKMARK).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Tag pages…" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Tag 2 pages" })).toBeVisible();
    await dialog.locator("#tag-date").fill("2026-04-10");
    await dialog.getByRole("combobox", { name: "Add a class" }).fill("thermo");
    await page.keyboard.press("Enter");
    await dialog.getByRole("button", { name: "Save tags" }).click();
    await expect(dialog).toHaveCount(0);

    // The tags are on the notebook's pages.
    await tile(page, "Lecture Notes").dblclick();
    for (const index of [7, 8]) {
      await expect(pageTile(page, index).locator(".pg-tags")).toHaveAttribute("title", /Thermodynamics/);
    }
    await expect(pageTile(page, 9).locator(".pg-tags")).toHaveCount(0);

    // The bookmarks panel tags them too.
    await page.getByRole("button", { name: `Tag pages of ${BOOKMARK}` }).click();
    await expect(dialog.locator(".tag-chips .class-chip")).toHaveText(["Thermodynamics"]);
    await dialog.getByRole("button", { name: "Cancel" }).click();

    // The bookmark reader shows the tags of the pages on screen and tags them.
    await page.goto("/");
    await tile(page, FOLDER).dblclick();
    await tile(page, BOOKMARK).dblclick();
    await expect(page.locator(".pdfViewer .page canvas").first()).toBeVisible();
    await expect(page.locator(".reader-tags")).toContainText("Thermodynamics");
    await page.getByRole("button", { name: "Tag pages" }).click();
    await page.getByRole("menuitem", { name: /Tag all 2 pages of the bookmark/ }).click();
    await expect(dialog.getByRole("heading", { name: "Tag 2 pages" })).toBeVisible();
    await dialog.getByRole("combobox", { name: "Add a class" }).fill("econ");
    await page.keyboard.press("Enter");
    await dialog.getByRole("button", { name: "Save tags" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".reader-tags")).toContainText("Économie politique");
  });

  test("search by class and date, with no words typed", async ({ page }) => {
    await signIn(page);
    await page.goto("/search");
    await expect(page.getByRole("heading", { name: "Search your library" })).toBeVisible();
    const contents = page.locator(".search-section", { hasText: "Contents" });
    const files = page.locator(".search-section", { hasText: "Files" });

    // Pages 3–6 have Organic Chemistry.
    await page.getByRole("combobox", { name: "Filter by class" }).fill("organic");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/search\?class=/);
    await expect(page.locator(".filter-chips")).toContainText("Organic Chemistry");
    await expect(contents.locator(".content-hit")).toHaveCount(1);
    await expect(contents.locator(".hit-page")).toHaveText([/p\. 3/, /p\. 4/, /p\. 5/, /p\. 6/]);
    await expect(files.locator(".list-view .row:not(.head)")).toHaveText([/Lecture Notes/]);

    // Only those dated in March: page 6 has no date.
    await page.locator(".filter-day", { hasText: "From" }).locator("input").fill("2026-03-01");
    await page.locator(".filter-day", { hasText: "To" }).locator("input").fill("2026-03-31");
    await expect(page).toHaveURL(/from=2026-03-01&to=2026-03-31/);
    await expect(contents.locator(".hit-page")).toHaveText([/p\. 3/, /p\. 4/, /p\. 5/]);

    // Without the class filter: everything dated in April, the bookmark's pages.
    await page.getByRole("button", { name: "Remove Organic Chemistry" }).click();
    await page.locator(".filter-day", { hasText: "To" }).locator("input").fill("");
    await page.locator(".filter-day", { hasText: "From" }).locator("input").fill("2026-04-01");
    await expect(page).not.toHaveURL(/class=/);
    await expect(contents.locator(".content-hit")).toHaveCount(2);
    await expect(contents.locator(".content-hit", { hasText: BOOKMARK }).locator(".hit-page")).toHaveCount(2);
    const rows = files.locator(".list-view .row:not(.head)");
    // The notebook and the bookmark.
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: BOOKMARK })).toHaveCount(1);

    // Typing a search keeps the filters.
    await page.getByRole("searchbox").fill("lecture");
    await expect(page).toHaveURL(/\/search\?q=lecture&from=2026-04-01/);
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page).toHaveURL(/\/search\?q=lecture$/);
  });
});
