// @effect-diagnostics nodeBuiltinImport:off - the scenario writes a fake Pi CLI and its settings.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { expect } from "e2e";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

const CHOSEN_MODEL = "anthropic/claude-sonnet-4";
// A supported Pi whose RPC discovery fails, so its catalog falls back to the "default" alias.
const FAKE_PI = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "0.84.3"; exit 0; fi
echo "scenario Pi cannot list models" >&2
exit 1
`;

test(
  "A Pi model chosen in Settings is still the one sent while Pi cannot list its models",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo");
    const fakePi = NodePath.join(T3_HOME, "bin/fake-pi");
    const settingsPath = NodePath.join(T3_HOME, "userdata/settings.json");
    const originalSettings = await NodeFSP.readFile(settingsPath, "utf8");
    const settings = JSON.parse(originalSettings);
    try {
      await NodeFSP.writeFile(fakePi, FAKE_PI, { mode: 0o755 });
      settings.providerInstances.pi = {
        driver: "pi",
        enabled: true,
        config: { binaryPath: fakePi },
      };
      settings.defaultModelSelection = { instanceId: "pi", model: CHOSEN_MODEL };
      await NodeFSP.writeFile(settingsPath, JSON.stringify(settings));

      await t3.open();
      // The composer shows a Pi model once the settings watcher has enabled Pi.
      await expect(browser.locator("[data-chat-provider-model-picker-label]").first()).toHaveText(
        /sonnet|default/i,
        { timeout: 60_000 },
      );
      await app.screenshot("composer");

      await screen.getByRole("textbox").fill("Which model is this?");
      await screen.getByRole("textbox").press("Enter");
      const { cli } = makeState(T3_HOME);
      await expect
        .poll(
          async () => {
            const listed = await runPromise(
              cli(["thread", "list", "--project", project, "--json"]),
            );
            const threads = JSON.parse(listed.stdout) as Array<{ model: string }>;
            return threads[0]?.model ?? null;
          },
          { timeout: 30_000 },
        )
        .toBe(CHOSEN_MODEL);
    } finally {
      await NodeFSP.writeFile(settingsPath, originalSettings);
      await NodeFSP.rm(fakePi, { force: true });
    }
  },
);
