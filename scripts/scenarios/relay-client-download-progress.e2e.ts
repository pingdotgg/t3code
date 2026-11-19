import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Relay client install dialog shows received bytes during a download",
  WEB,
  async ({ t3, app, screen, browser }) => {
    await t3.project("demo");
    await t3.open();

    await browser.evaluate(async () => {
      const loadDialog = new Function("return import('/src/cloud/relayClientInstallDialog.ts')");
      const dialog = await loadDialog();
      const confirmation = dialog.requestRelayClientInstallConfirmation("2026.11.0");
      dialog.respondToRelayClientInstallConfirmation(true);
      await confirmation;
      dialog.reportRelayClientInstallProgress({
        type: "progress",
        stage: "downloading",
        downloadedBytes: 128 * 1024 * 1024,
        totalBytes: 228 * 1024 * 1024,
      });
      return true;
    });

    await app.screenshot("relay-download-progress");
    await expect(screen.getByText("128.0 MB of 228.0 MB downloaded")).toBeVisible();
  },
);
