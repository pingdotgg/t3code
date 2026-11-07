// @effect-diagnostics globalTimers:off - browser steps shared by the stress rig's CLIs.
import type { Page } from "playwright";

/** Opens a sidebar thread by title, expanding the collapsed groups (Working, Settled) it sits in. */
export async function openThread(page: Page, title: string) {
  const item = page
    // Exact title text: badges such as a linked pull request number follow it without a space.
    .locator('[role="treeitem"]', { has: page.getByText(title, { exact: true }) })
    .first();
  // Expanding one group re-renders the tree, so look for the next collapsed group each time.
  for (let attempt = 0; attempt < 5 && !(await item.isVisible()); attempt++) {
    const group = page
      .locator('[role="treeitem"][aria-expanded="false"]')
      .filter({ visible: true })
      .first();
    if ((await group.count()) === 0) break;
    await group.click();
  }
  // A loaded page can block for seconds; the click waits it out rather than skipping the step.
  await item.click({ timeout: 15_000 });
  await page
    .locator('nav[aria-label="Thread breadcrumb"]', { hasText: title })
    .waitFor({ timeout: 10_000 });
}

/** Links a pull request to the open thread through the command palette. */
export async function linkPullRequest(page: Page, url: string) {
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("Link pull request");
  await page
    .getByRole("option", { name: /Link pull request to thread/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Link pull request" });
  await dialog.getByRole("textbox").fill(url);
  await dialog.getByRole("button", { name: "Link", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
}

/** Opens the linked pull request from the thread details card into the right panel. */
export async function openPullRequestPanel(page: Page, title: string) {
  const link = page.getByText(title, { exact: true }).first();
  // The details card is a panel the user can close; another page may have left it closed.
  const shown = await link
    .waitFor({ timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (!shown) {
    await page.getByRole("button", { name: "Toggle thread details panel" }).click();
  }
  await link.click();
  await pullRequestTabs(page).waitFor({ timeout: 60_000 });
}

const pullRequestTabs = (page: Page) => page.locator('nav[aria-label="Pull request tabs"]');

export async function selectPullRequestTab(page: Page, tab: "Summary" | "Timeline" | "Code") {
  await pullRequestTabs(page)
    .locator("button", { hasText: new RegExp(`^${tab}$`) })
    .click();
}

// Steps below run during measurement, so they use CSS selectors: role queries compute the
// accessible name of every candidate, which costs seconds on a page this large.

/** Expands the next `count` collapsed file diffs in the code tab. */
export async function expandDiffs(page: Page, count: number) {
  const buttons = page.locator('button[aria-label="Expand diff"]');
  for (let index = 0; index < count && (await buttons.count()) > 0; index++) {
    await buttons.first().click({ timeout: 5000 });
  }
}

/** Scrolls every scrollable region to its end, so lists that load more as they show do. */
export async function scrollEverything(page: Page, passes = 40) {
  for (let pass = 0; pass < passes; pass++) {
    const moved = await page.evaluate(() => {
      let any = false;
      for (const element of document.querySelectorAll<HTMLElement>("*")) {
        const room = element.scrollHeight - element.clientHeight;
        if (room > 40 && element.scrollTop < room - 4) {
          element.scrollTop = element.scrollHeight;
          any = true;
        }
      }
      return any;
    });
    await page.waitForTimeout(1500);
    if (!moved) return;
  }
}
