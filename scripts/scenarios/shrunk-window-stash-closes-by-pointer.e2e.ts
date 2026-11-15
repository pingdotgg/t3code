/// <reference lib="dom" />
// The DOM lib types the function this scenario runs in the page.
import { expect } from "e2e";

import { clickAt, findHitPoint, openThreadWithManyFiles } from "./composer-menu.ts";
import { test, WEB } from "./t3.ts";

test(
  "After the window shrinks, the open Prompt Stash can still be closed with the pointer",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await browser.setViewport({ width: 375, height: 500 });
    await openThreadWithManyFiles(t3);
    await screen.getByRole("button", "Expand composer").tap();
    for (let entry = 1; entry <= 6; entry += 1) {
      await screen.getByRole("textbox").tap();
      await browser.keyboard.type(`stashed prompt ${entry}`);
      await browser.keyboard.press("Control+s");
    }
    await screen.getByRole("textbox").tap();
    for (let line = 1; line <= 14; line += 1) {
      await browser.keyboard.type(`line ${line}`);
      if (line < 14) await browser.keyboard.press("Shift+Enter");
    }
    await screen.getByRole("button", "Stashed prompts", { exact: false }).tap();
    await expect(screen.getByRole("button", "Close stash")).toBeVisible();

    await browser.setViewport({ width: 375, height: 320 });
    await app.screenshot("stash-after-shrink");
    const close = await findHitPoint(browser, '[aria-label="Close stash"]');
    expect(close).not.toBeNull();

    await clickAt(browser, close!);
    await expect
      .poll(() =>
        browser.evaluate(() => document.querySelectorAll("[data-composer-stash-drawer]").length),
      )
      .toBe(0);
  },
);
