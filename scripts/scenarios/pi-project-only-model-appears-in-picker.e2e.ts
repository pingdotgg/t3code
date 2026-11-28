// @effect-diagnostics nodeBuiltinImport:off - the scenario installs an isolated Pi RPC fixture.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { expect } from "e2e";

import { T3_HOME } from "../e2e.config.ts";
import { test, WEB } from "./t3.ts";

const FAKE_PI = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
if (process.argv.includes("--version")) {
  console.log("0.84.3");
  process.exit(0);
}
const models = [];
if (fs.existsSync(".pi/project-model") && !process.argv.includes("--no-extensions")) {
  models.push({ provider: "fixture", id: "project-model", name: "Project-only model" });
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { type, id } = JSON.parse(line);
  const data = type === "get_available_models" ? { models } :
    type === "get_commands" ? { commands: [] } : { model: models[0] };
  console.log(JSON.stringify({ type: "response", id, success: true, data }));
});
`;

test(
  "Pi is selectable with only a project-registered model",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("Pi workspace", { ".pi/project-model": "" });
    const fakePi = NodePath.join(T3_HOME, "bin/project-only-pi.cjs");
    const settingsPath = NodePath.join(T3_HOME, "userdata/settings.json");
    const original = await NodeFSP.readFile(settingsPath, "utf8");
    const settings = JSON.parse(original);
    try {
      await NodeFSP.writeFile(fakePi, FAKE_PI, { mode: 0o755 });
      settings.providerInstances.pi = {
        driver: "pi",
        enabled: true,
        config: { binaryPath: fakePi },
      };
      settings.defaultModelSelection = { instanceId: "pi", model: "default" };
      await NodeFSP.writeFile(settingsPath, JSON.stringify(settings));

      await t3.open();
      await browser.locator("[data-chat-provider-model-picker-label]").first().tap();
      const search = screen.getByPlaceholder("Search models...");
      await search.fill("Project-only model");
      await app.screenshot("project-model-search");
      await expect(screen.getByRole("option", /^Project-only model\b/)).toBeVisible();
    } finally {
      await NodeFSP.writeFile(settingsPath, original);
      await NodeFSP.rm(fakePi, { force: true });
    }
  },
);
