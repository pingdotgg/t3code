import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

const KEPT = "a".repeat(199);
// The emoji's two UTF-16 units straddle unit 200, where both pages cut the search.
const QUERY = `${KEPT}😀 rest`;

test(
  "A long Issues or Pull Requests search ends without a broken character",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("demo");
    // The search is wider than its box, so the capture needs the box scrolled to its end.
    const showSearchEnd = () =>
      browser.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>('[role="searchbox"]')!;
        input.scrollLeft = input.scrollWidth;
        return null;
      });

    await t3.open(`/issues?${new URLSearchParams({ q: QUERY })}`);
    const issues = screen.getByRole("searchbox", "Search issues");
    await issues.waitFor({ timeout: 60_000 });
    await showSearchEnd();
    await app.screenshot("issues-search");
    await expect(issues).toHaveValue(KEPT);

    await t3.open(`/pull-requests?${new URLSearchParams({ q: QUERY })}`);
    const pullRequests = screen.getByRole("searchbox", "Search pull requests");
    await pullRequests.waitFor({ timeout: 60_000 });
    await showSearchEnd();
    await app.screenshot("pull-requests-search");
    await expect(pullRequests).toHaveValue(KEPT);
  },
);
