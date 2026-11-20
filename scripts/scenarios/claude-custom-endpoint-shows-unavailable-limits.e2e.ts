// @effect-diagnostics nodeBuiltinImport:off - the scenario writes a fake Claude CLI and its settings.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { expect } from "e2e";

import { APP_DIR, T3_HOME } from "../e2e.config.ts";
import { test, WEB } from "./t3.ts";

test(
  "A Claude instance behind a custom endpoint shows Unavailable, not the local login's limits",
  WEB,
  async ({ t3, app, screen, browser }) => {
    await t3.project("demo");
    // The fixture answers get_usage with a signed-in login's limits, as the real CLI does.
    const fixture = NodePath.join(
      APP_DIR,
      "apps/server/src/provider/testing/ProviderInstanceRegistryLive.fixture.mjs",
    );
    const fakeClaude = NodePath.join(T3_HOME, "bin/fake-claude");
    const settingsPath = NodePath.join(T3_HOME, "userdata/settings.json");
    const originalSettings = await NodeFSP.readFile(settingsPath, "utf8");
    const settings = JSON.parse(originalSettings);
    try {
      await NodeFSP.writeFile(fakeClaude, `#!/bin/sh\nexec node "${fixture}" "$@"\n`, {
        mode: 0o755,
      });
      settings.providerInstances.claudeAgent = {
        driver: "claudeAgent",
        enabled: true,
        config: { binaryPath: fakeClaude },
        environment: [
          { name: "ANTHROPIC_BASE_URL", value: "https://hub.example.test", sensitive: false },
        ],
      };
      settings.defaultModelSelection = { instanceId: "claudeAgent", model: "sonnet" };
      await NodeFSP.writeFile(settingsPath, JSON.stringify(settings));

      // The usage item is off by default and lives in the browser's client settings, so turn it on in Settings.
      await t3.open("/settings/appearance");
      await screen.getByRole("button", /Thread details: \d+ of \d+ on/).tap();
      await screen.getByRole("menuitemcheckbox", "Usage limits").tap();
      await browser.keyboard.press("Escape");

      await t3.open();
      // The usage card belongs to a thread, not the draft, so start one on the Claude instance.
      await screen.getByRole("textbox").fill("Which limits apply to this thread?");
      await screen.getByRole("textbox").press("Enter");
      await expect(
        screen.getByText("Which limits apply to this thread?", { exact: false }).first(),
      ).toBeVisible();
      // The thread details panel is open by default, so the usage row is already on screen.
      await app.screenshot("usage-card");
      await expect(screen.getByRole("link", "Limits: Unavailable")).toBeVisible({
        timeout: 60_000,
      });
      await app.screenshot("usage-unavailable");
    } finally {
      await NodeFSP.writeFile(settingsPath, originalSettings);
      await NodeFSP.rm(fakeClaude, { force: true });
    }
  },
);
