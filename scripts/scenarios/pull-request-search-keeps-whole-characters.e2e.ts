import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

const KEPT = "a".repeat(47);
// The emoji's two UTF-16 units straddle unit 48, where the shown search is cut.
const QUERY = `${KEPT}😀 and the rest of the search`;

test(
  "A long pull request search that matches nothing ends without a broken character",
  WEB,
  async ({ t3, app, screen }) => {
    await t3.project("demo");
    await t3.open(`/pull-requests?${new URLSearchParams({ q: QUERY })}`);

    const title = screen.getByText(/^Nothing matches/);
    await title.waitFor({ timeout: 60_000 });
    await app.screenshot("no-matches");
    await expect(title).toHaveText(`Nothing matches “${KEPT}…”`);
  },
);
