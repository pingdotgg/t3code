import { EnvironmentHttpApi } from "@t3tools/contracts";
import { expect } from "e2e";

import { startSecondServer } from "./second-server.ts";
import { test, WEB } from "./t3.ts";

test(
  "A finished pairing leaves the reopened Add Environment dialog open",
  WEB,
  async ({ t3, app, screen, browser }) => {
    await t3.project("demo");
    const server = startSecondServer(app.baseUrl ?? "");
    const pairingStarted = Promise.withResolvers<void>();
    const releasePairing = Promise.withResolvers<void>();
    try {
      const { host, token } = await server.ready;
      const descriptorPath = EnvironmentHttpApi.groups.metadata.endpoints.descriptor.path;
      await browser.route(`${host}${descriptorPath}`, async (route) => {
        pairingStarted.resolve();
        await releasePairing.promise;
        await route.continue();
      });

      await t3.open("/settings/connections");
      const open = browser.locator('#remote-environments button[aria-label="Add environment"]');
      const dialog = screen.getByRole("dialog", "Add Environment");
      await open.tap();
      await dialog.getByPlaceholder("backend.example.com").fill(host);
      await dialog.getByPlaceholder("PAIRCODE").fill(token);
      await dialog.getByRole("button", "Add environment").tap();
      await pairingStarted.promise;

      await dialog.getByRole("button", "Close", { exact: true }).tap();
      await dialog.waitFor({ state: "hidden" });
      await open.tap();
      await dialog.waitFor();

      releasePairing.resolve();
      await screen.getByText("Backend added", { exact: true }).waitFor({ timeout: 30_000 });

      await app.screenshot("after-first-pairing-finishes");
      await expect(dialog).toBeVisible();
    } finally {
      releasePairing.resolve();
      await server.stop();
    }
  },
);
