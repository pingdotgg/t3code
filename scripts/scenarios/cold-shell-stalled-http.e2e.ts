import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A client with no cached threads lists them over the socket when the HTTP shell request stalls",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo");
    await t3.thread({ project, title: "Original thread", messages: ["first"] });

    // A proxy that lets /ws through but never answers the shell route.
    const held: Array<() => Promise<void>> = [];
    await browser.route("**/api/orchestration/shell**", (route) => {
      return new Promise<void>((resolve) => {
        held.push(() =>
          route
            .abort()
            .catch(() => {})
            .then(resolve),
        );
      });
    });

    await t3.open();
    // Pairing reloads the page once, so this covers that reload plus the 3 second deadline.
    await expect(screen.getByText("Original thread").first()).toBeVisible({ timeout: 8_000 });
    await app.screenshot("listed");
    for (const release of held) await release();
  },
);
