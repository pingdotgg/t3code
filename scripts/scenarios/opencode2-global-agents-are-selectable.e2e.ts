// @effect-diagnostics nodeBuiltinImport:off - the scenario serves OpenCode discovery responses.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodePath from "node:path";

import { expect } from "e2e";

import { T3_HOME } from "../e2e.config.ts";
import { test, WEB } from "./t3.ts";

// OpenCode 2's native discovery protocol; no session or paid model is started.
function discoveryServer() {
  return NodeHttp.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://opencode");
    const location = { directory: url.searchParams.get("location[directory]") ?? "/work" };
    const json = (value: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === "/api/info") {
      return json({ version: "2.3.0", pid: 1, urls: [], paths: { tmp: "/tmp/opencode" } });
    }
    if (url.pathname === "/api/provider") {
      return json({
        location,
        data: [
          {
            id: "demo",
            integrationID: "demo",
            name: "Demo",
            activation: "enabled",
            package: "@opencode/ai/providers/openai-compatible",
            settings: {},
          },
        ],
      });
    }
    if (url.pathname === "/api/model") {
      return json({
        location,
        data: [
          {
            id: "demo",
            modelID: "demo",
            providerID: "demo",
            name: "Agent selection demo",
            package: "@opencode/ai/providers/openai-compatible",
            settings: {},
            compatibility: {},
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            variants: [],
            time: { released: 1760659200000 },
            cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
            status: "active",
            enabled: true,
            limit: { context: 200000, output: 32000 },
          },
        ],
      });
    }
    if (url.pathname === "/api/agent") {
      return json({
        location,
        data: [
          { id: "build", name: "Build", mode: "primary", hidden: false },
          { id: "zai-codex", name: "zai-codex", mode: "primary", hidden: false },
          { id: "zai-direct", name: "zai-direct", mode: "primary", hidden: false },
          { id: "deepseek-codex", name: "deepseek-codex", mode: "primary", hidden: false },
          { id: "worker", name: "Internal worker", mode: "subagent", hidden: false },
          { id: "hidden", name: "Hidden agent", mode: "primary", hidden: true },
        ].map((agent) => ({
          ...agent,
          request: { settings: {}, headers: {}, body: {} },
          permissions: [],
        })),
      });
    }
    if (url.pathname === "/api/command" || url.pathname === "/api/skill") {
      return json({ location, data: [] });
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"_tag":"NotFoundError","message":"No recorded response"}');
  });
}

test(
  "OpenCode 2 exposes global primary agents in the model picker",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const server = discoveryServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const settingsPath = NodePath.join(T3_HOME, "userdata/settings.json");
    const original = await NodeFSP.readFile(settingsPath, "utf8");
    try {
      const { port } = server.address() as NodeNet.AddressInfo;
      const settings = JSON.parse(original);
      settings.providerInstances.opencode = {
        driver: "opencode",
        enabled: true,
        config: { serverUrl: `http://127.0.0.1:${port}` },
      };
      settings.defaultModelSelection = { instanceId: "opencode", model: "demo/demo" };
      await NodeFSP.writeFile(settingsPath, JSON.stringify(settings));
      await t3.project("demo");
      await t3.open();
      const picker = browser.locator("[data-chat-provider-model-picker-label]").first();
      await expect(picker).toHaveText("Agent selection demo", { timeout: 60_000 });
      await picker.tap();
      await app.screenshot("agent-picker");
      const agent = screen.getByRole("button", "Agent: Build");
      await expect(agent).toBeVisible();
      await agent.tap();
      await expect(screen.getByRole("menuitemradio", "zai-codex")).toBeVisible();
      await expect(screen.getByRole("menuitemradio", "zai-direct")).toBeVisible();
      await expect(screen.getByRole("menuitemradio", "deepseek-codex")).toBeVisible();
      await expect(screen.getByRole("menuitemradio", "Internal worker")).not.toBeVisible();
      await expect(screen.getByRole("menuitemradio", "Hidden agent")).not.toBeVisible();
      await app.screenshot("agent-choices");
      await screen.getByRole("menuitemradio", "zai-direct").tap();
      await expect(screen.getByRole("button", "Agent: zai-direct")).toBeVisible();
    } finally {
      await NodeFSP.writeFile(settingsPath, original);
      server.closeAllConnections();
      server.close();
    }
  },
);
