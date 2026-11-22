// @effect-diagnostics nodeBuiltinImport:off - the scenario writes a fake Pi CLI and its settings.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { expect } from "e2e";

import { T3_HOME } from "../e2e.config.ts";
import { test, WEB } from "./t3.ts";

const CHOSEN_MODEL = "anthropic/claude-opus-5-5";
// Pi's own catalog lists Claude Opus 5.5 with its API and no serviceTiers, so Fast must come from T3.
const FAKE_PI = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("pi 1.6.0");
  process.exit(0);
}
if (args[0] === "auth") {
  console.log(JSON.stringify({ status: "ready", provider: "anthropic" }));
  process.exit(0);
}
const data = {
  get_available_models: {
    models: [
      {
        provider: "anthropic",
        id: "claude-opus-5-5",
        name: "Claude Opus 5.5",
        api: "anthropic-messages",
        reasoning: true,
      },
    ],
  },
  get_state: {
    model: { provider: "anthropic", id: "claude-opus-5-5" },
    thinkingLevel: "medium",
  },
  get_commands: { commands: [] },
};
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim() === "") continue;
    const request = JSON.parse(line);
    process.stdout.write(
      JSON.stringify({
        type: "response",
        id: request.id,
        command: request.type,
        success: true,
        data: data[request.type] ?? {},
      }) + "\\n",
    );
  }
});
`;

test(
  "A Pi Claude model that supports fast mode offers Fast in the composer and keeps it selected",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("demo");
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
      // The speed control lives in the model picker's footer, one click from the composer.
      await expect(browser.locator("[data-chat-provider-model-picker-label]").first()).toHaveText(
        /Opus 5\.5/,
        { timeout: 60_000 },
      );
      await browser.locator("[data-chat-provider-model-picker-label]").first().click();
      const serviceTier = browser.locator('[role="radiogroup"][aria-label="Service Tier"]');
      await expect(serviceTier).toBeVisible({ timeout: 60_000 });
      await app.screenshot("model-picker-service-tier");

      const fast = screen.getByRole("radio", "Fast", { exact: true });
      await fast.click();
      await expect(fast).toHaveAttribute("aria-checked", "true");
      await app.screenshot("fast-selected");
    } finally {
      await NodeFSP.writeFile(settingsPath, originalSettings);
      await NodeFSP.rm(fakePi, { force: true });
    }
  },
);
