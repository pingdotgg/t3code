import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Finishing a pairing link leaves a reopened Create link dialog open",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("demo");
    const pairingToken = "**/api/auth/pairing-token";
    const requested = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await browser.route(pairingToken, async (route) => {
      if (route.request.method !== "POST") return route.fallback();
      requested.resolve();
      // Simulate a delayed request without replacing the server's response.
      await release.promise;
      await route.continue();
    });

    await t3.open("/settings/access");
    const authorizedClients = browser.locator("#authorized-clients");
    const open = authorizedClients.getByRole("button", "Create link", { exact: true });
    const dialog = screen.getByRole("dialog", "Create pairing link", { exact: true });
    const label = "Waiting tablet";
    try {
      await open.tap();
      await dialog.getByPlaceholder("e.g. Living room iPad").fill(label);
      await dialog.getByRole("button", "Create link", { exact: true }).tap();
      await requested.promise;
      await dialog.getByRole("button", "Creating…", { exact: true }).waitFor();
      await browser.keyboard.press("Escape");

      const openPopup = browser
        .locator('[data-slot="dialog-popup"][data-open]')
        .getByRole("heading", "Create pairing link", { exact: true });
      const dismissed = !(await openPopup.isVisible());
      if (dismissed) {
        await dialog.waitFor({ state: "hidden" });
        await open.tap();
        await dialog.waitFor();
      }

      release.resolve();
      await authorizedClients.getByText(label, { exact: true }).waitFor();
      await app.screenshot("after-first-link-finishes");
      expect(
        !dismissed || (await openPopup.isVisible()),
        "The reopened Create link dialog remains open",
      ).toBe(true);
    } finally {
      release.resolve();
      await browser.unroute(pairingToken);
    }
  },
);
