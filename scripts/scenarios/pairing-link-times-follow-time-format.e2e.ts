import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Pairing link times in Settings follow the 24-hour Time format",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("demo");
    await t3.open("/settings/general");
    await screen.getByRole("combobox", "Timestamp format").tap();
    await screen.getByRole("option", "24-hour", { exact: true }).tap();

    await t3.open("/settings/access");
    const authorizedClients = browser.locator("#authorized-clients");
    await authorizedClients.getByRole("button", "Create link", { exact: true }).tap();
    const dialog = screen.getByRole("dialog", "Create pairing link", { exact: true });
    await dialog.getByPlaceholder("e.g. Living room iPad").fill("Test phone");
    await dialog.getByRole("button", "Create link", { exact: true }).tap();
    await authorizedClients.getByText("Test phone", { exact: true }).waitFor();
    await dialog.waitFor({ state: "hidden" });
    // First hover after dialog close won't open the tooltip; move onto the row first.
    await authorizedClients.getByText("Test phone", { exact: true }).hover();
    await authorizedClients.getByText(/^Expires in/).hover();
    await browser.locator('[data-slot="tooltip-popup"]:not([data-starting-style])').waitFor();
    // Capture the settled tooltip, not its fade-in.
    await browser.evaluate(() => {
      const tooltip = document.querySelector('[data-slot="tooltip-popup"]');
      for (const animation of tooltip?.getAnimations({ subtree: true }) ?? []) {
        if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish();
      }
      return null;
    });

    try {
      // Expects a 12-hour default browser locale; 24-hour locales already format HH:MM on main.
      await expect(authorizedClients.getByRole("button", /^Link created at /)).toHaveAccessibleName(
        /\b\d{2}:\d{2}$/,
      );
      await expect(browser.locator('[data-slot="tooltip-viewport"]')).toHaveText(/\b\d{2}:\d{2}$/);
    } finally {
      await app.screenshot("pairing-link-expiry-tooltip");
    }
  },
);
