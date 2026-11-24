// @effect-diagnostics nodeBuiltinImport:off - the scenario writes a fake Codex CLI and its settings.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { expect } from "e2e";

import { T3_HOME } from "../e2e.config.ts";
import { test, WEB } from "./t3.ts";

const PREFIX = "Codex CLI command failed: ";
const KEPT = `${PREFIX}${"The title model refused this request. ".repeat(10)}`.slice(0, 298);
// The emoji's two UTF-16 units straddle unit 299, where the server cuts the failure message.
const FAKE_CODEX = `#!/bin/sh
printf '%s\\n' '${KEPT.slice(PREFIX.length)}😀 and the rest of the error' >&2
exit 1
`;

test(
  "A long title regeneration failure ends without a broken character",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const fakeCodex = NodePath.join(T3_HOME, "bin/fake-codex");
    const settingsPath = NodePath.join(T3_HOME, "userdata/settings.json");
    const originalSettings = await NodeFSP.readFile(settingsPath, "utf8");
    const settings = JSON.parse(originalSettings);
    try {
      await NodeFSP.writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
      settings.providerInstances.codex = {
        driver: "codex",
        enabled: true,
        config: { binaryPath: fakeCodex },
      };
      await NodeFSP.writeFile(settingsPath, JSON.stringify(settings));

      const project = await t3.project("demo");
      const thread = await t3.thread({ project, title: "Earlier work", messages: ["first"] });
      await t3.open(thread);

      await screen.getByRole("button", "Thread actions for Earlier work").tap();
      await screen.getByRole("menuitem", "Regenerate title").tap();
      await expect(screen.getByText("Failed to regenerate thread title")).toBeVisible();
      // Read the toast once: it closes by itself, and its four-line clamp hides the cut.
      const message = await browser.locator('[data-slot="toast-description"]').textContent();
      await app.screenshot("regenerate-failed");
      expect(message).toBe(`${KEPT}…`);
    } finally {
      await NodeFSP.writeFile(settingsPath, originalSettings);
      await NodeFSP.rm(fakeCodex, { force: true });
    }
  },
);
