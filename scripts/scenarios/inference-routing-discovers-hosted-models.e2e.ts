/// <reference lib="dom" />
// @effect-diagnostics nodeBuiltinImport:off - prepares an isolated server and fake CLI binaries.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { APP_DIR } from "../e2e.config.ts";
import { SECOND_HOME, startSecondServer } from "./second-server.ts";
import { environmentId, makeState, runPromise, test, WEB } from "./t3.ts";

const fakeProxy = `#!/usr/bin/env node
const { createServer } = require("node:http");
const { readFileSync } = require("node:fs");
const config = JSON.parse(readFileSync(process.argv[process.argv.indexOf("-config") + 1], "utf8"));
createServer((request, response) => {
  const { url, headers, method } = request;
  const key = url.startsWith("/v0/management/")
    ? config.management["secret-key"]
    : config.access["api-keys"][0];
  let body;
  if (method === "GET" && headers.authorization === "Bearer " + key) {
    const { models, coolingDown } = JSON.parse(readFileSync("./scenario-models.json", "utf8"));
    if (url === "/v0/management/auth-files")
      body = { files: [{
        name: "codex-fixture@example.invalid.json",
        provider: "codex",
        status: "active",
        ...(coolingDown ? { cooldowns: [{ scope: "model", model_key: coolingDown, retry_at: "2099-01-01T00:00:00Z" }] } : {}),
      }] };
    else if (url.startsWith("/v0/management/auth-files/models?"))
      body = { models: models.map((id) => ({ id })) };
    else if (url === "/v1/models")
      body = { data: models.filter((id) => id !== coolingDown).map((id) => ({ id, owned_by: "openai" })) };
  }
  response.writeHead(body ? 200 : 404, { "content-type": "application/json" });
  response.end(JSON.stringify(body ?? {}));
}).listen(config.server.port, "127.0.0.1");
`;

const fakeCodex = `#!/usr/bin/env node
if (!process.argv.includes("app-server")) process.exit(1);
const replies = {
  initialize: { userAgent: "codex-cli/0.167.0", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: process.platform },
  "account/read": { account: null, requiresOpenaiAuth: false },
  "config/read": { config: {}, origins: {}, layers: null },
  "model/list": { data: [], nextCursor: null },
  "skills/list": { data: [] },
};
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (id !== undefined) console.log(JSON.stringify(replies[method]
    ? { id, result: replies[method] }
    : { id, error: { code: -32601, message: "Fixture does not execute turns." } }));
});
`;

const loopbackFetch = `
const fetchLoopback = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    return Promise.reject(new Error("Scenario fixture allows loopback requests only."));
  return fetchLoopback(input, init);
};
`;

const modelsFile = NodePath.join(SECOND_HOME, "userdata/inference-proxy/scenario-models.json");
const sol = "gpt-6.2-sol";
const astra = "gpt-6.2-astra";

async function prepare(home: string) {
  const [platform, architecture] = await runPromise(
    Effect.all([HostProcess.Platform, HostProcess.Architecture]),
  );
  const installer = await NodeFSP.readFile(
    NodePath.join(APP_DIR, "apps/server/src/inference/install.ts"),
    "utf8",
  );
  const version = /^export const proxyVersion = "(\d+\.\d+\.\d+)";$/m.exec(installer)?.[1];
  if (!version) throw new Error("The fixture could not find the pinned proxy version.");
  const runtime = NodePath.join(
    home,
    "userdata/inference-proxy/runtime",
    `${version}-${platform}-${architecture}`,
  );
  const codex = NodePath.join(home, "bin/codex-fixture");
  const settings = NodePath.join(home, "userdata/settings.json");
  const offlineModule = NodePath.join(home, "loopback-fetch.mjs");

  await NodeFSP.mkdir(runtime, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(home, "package.json"),
    JSON.stringify({ type: "commonjs" }),
  );
  await NodeFSP.writeFile(NodePath.join(runtime, "cli-proxy-api"), fakeProxy, { mode: 0o755 });
  await NodeFSP.writeFile(codex, fakeCodex, { mode: 0o755 });
  await NodeFSP.writeFile(offlineModule, loopbackFetch);
  await NodeFSP.writeFile(modelsFile, JSON.stringify({ models: [sol] }));
  const config: {
    enableProviderUpdateChecks: boolean;
    providerInstances: { codex: { config: { binaryPath: string } } };
  } = JSON.parse(await NodeFSP.readFile(settings, "utf8"));
  config.enableProviderUpdateChecks = false;
  config.providerInstances.codex.config.binaryPath = codex;
  await NodeFSP.writeFile(settings, JSON.stringify(config));

  return {
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: NodePath.join(home, "codex"),
    CLAUDE_CONFIG_DIR: NodePath.join(home, "claude"),
    NODE_OPTIONS: `--import=${NodeURL.pathToFileURL(offlineModule).href}`,
  };
}

test(
  "Hosted Codex models get display names and leave the picker during a cooldown",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("demo");
    const server = startSecondServer(app.baseUrl ?? "", prepare);
    try {
      const { host, token } = await server.ready;
      const machine = `machine=${encodeURIComponent(await runPromise(environmentId(host)))}`;
      await makeState(SECOND_HOME).state.project("Hosted models");
      await t3.open("/settings/connections");
      await screen.getByRole("button", "Add environment").tap();
      const dialog = screen.getByRole("dialog");
      await dialog.getByPlaceholder("backend.example.com").fill(host);
      await dialog.getByPlaceholder("PAIRCODE").fill(token);
      await dialog.getByRole("button", "Add environment").tap();
      await screen.getByRole("button", /^More actions for (?!this machine)/).waitFor();
      await app.open(`/settings/inference?${machine}`);
      const hosting = screen.getByRole("switch", "Host inference accounts");
      await hosting.tap();
      await expect(hosting).toBeChecked();

      await app.open(`/settings/providers?${machine}&instanceId=codex`);
      const routing = screen.getByRole("switch", /^(Use CLI proxy|Inference routing)$/i);
      await routing.tap();
      await expect(routing).toBeChecked();
      const details = browser.locator("[data-provider-detail]");
      const solRow = browser.locator(`[data-model-slug="${sol}"]`);
      const astraRow = browser.locator(`[data-model-slug="${astra}"]`);
      await expect(details.getByText("v0.167.0", { exact: true })).toBeVisible();
      await expect(details.getByText("Available", { exact: true })).toBeVisible();
      await expect(solRow).toBeVisible();

      const refresh = screen.getByRole("button", /refresh provider status|checked just now/i);
      await NodeFSP.writeFile(modelsFile, JSON.stringify({ models: [sol, astra] }));
      await refresh.tap();
      await expect(astraRow).toBeVisible();
      await expect(solRow).toBeVisible();
      await astraRow.scrollIntoView();
      await app.screenshot("hosted-models-after-refresh");

      await app.open("/");
      await screen.getByRole("button", "New thread", { exact: true }).tap();
      await screen.getByRole("option", /Hosted models/).tap();
      await expect(browser).toHaveURL(/\/draft\//);
      const draft = await browser.evaluate(() => window.location.pathname);
      const picker = browser.locator("[data-chat-provider-model-picker]");
      const astraOption = screen.getByRole("option", /gpt-6\.2-astra/i);
      const openPicker = async () => {
        await picker.tap();
        await screen.getByPlaceholder("Search models...").fill("6.2");
      };
      await openPicker();
      await app.screenshot("hosted-models-in-composer");
      await astraOption.tap();

      const updateCatalog = async (coolingDown?: string) => {
        await NodeFSP.writeFile(modelsFile, JSON.stringify({ models: [sol, astra], coolingDown }));
        await app.open(`/settings/providers?${machine}&instanceId=codex`);
        await refresh.tap();
        await expect(refresh).toBeEnabled();
        await app.open(draft);
        await openPicker();
      };
      await updateCatalog(astra);
      await app.screenshot("astra-during-cooldown");
      await expect(astraOption).toBeHidden();
      await expect(picker).toHaveAttribute("aria-label", /GPT-6\.2-Astra.*Unavailable/);
      await expect(screen.getByRole("option", /gpt-6\.2-sol/i)).toBeEnabled();
      await updateCatalog();
      await expect(screen.getByRole("option", /GPT-6\.2-Astra/)).toBeEnabled();
      await expect(screen.getByRole("option", /GPT-6\.2-Sol/)).toBeEnabled();
    } finally {
      await server.stop();
    }
  },
);
