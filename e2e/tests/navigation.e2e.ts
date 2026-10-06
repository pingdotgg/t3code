import { expect } from "e2e";

import { describe, test } from "../support/test.ts";

describe("navigation", { tags: ["smoke"] }, () => {
  test("the command palette opens settings", async ({ t3, browser, screen }) => {
    await t3.open();
    await t3.pressShortcut("k");
    const palette = screen.getByRole("dialog", "Command palette");
    await palette.getByRole("option", /^Open settings/).tap();
    await expect(browser).toHaveURL(/\/settings\//);
  });

  test("dark mode survives a reload and switches back", async ({ app, browser, screen, t3 }) => {
    const isDark = () =>
      browser.evaluate(() => document.documentElement.classList.contains("dark"));
    await t3.open();
    await app.open("/settings/appearance");
    await screen.getByRole("button", "Use dark mode").tap();
    await expect.poll(isDark).toBe(true);
    await browser.reload();
    await expect(screen.getByRole("button", "Use light mode")).toBeVisible();
    await expect.poll(isDark).toBe(true);
    await screen.getByRole("button", "Use light mode").tap();
    await expect.poll(isDark).toBe(false);
  });
});
