// @effect-diagnostics nodeBuiltinImport:off - prepares an isolated server and fake CLI binaries.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { APP_DIR } from "../e2e.config.ts";
import { SECOND_HOME, startSecondServer } from "./second-server.ts";
import { environmentId, runPromise, test, WEB } from "./t3.ts";

const fakeProxy = `#!/usr/bin/env node
const { createServer } = require("node:http");
const { readFileSync } = require("node:fs");
const config = JSON.parse(readFileSync(process.argv[process.argv.indexOf("-config") + 1], "utf8"));
createServer((request, response) => {
  const { url, headers, method } = request;
  const key = url === "/v0/management/auth-files"
    ? config.management["secret-key"]
    : config.access["api-keys"][0];
  let body;
  if (method === "GET" && headers.authorization === "Bearer " + key) {
    if (url === "/v0/management/auth-files")
      body = { files: [{ name: "codex-fixture@example.invalid.json", provider: "codex", status: "active" }] };
    else if (url === "/v1/models")
      body = { data: JSON.parse(readFileSync("./scenario-models.json", "utf8")).map((id) => ({ id, owned_by: "openai" })) };
  }
  response.writeHead(body ? 200 : 404, { "content-type": "application/json" });
  response.end(JSON.stringify(body ?? {}));
}).listen(config.server.port, "127.0.0.1");
`;

const fakeCodex = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.167.0");
  process.exit(0);
}
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
  await NodeFSP.writeFile(modelsFile, JSON.stringify([sol]));
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
  "The Codex switch connects to a hosted catalog and provider refresh adds newly advertised models",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("demo");
    const server = startSecondServer(app.baseUrl ?? "", prepare);
    try {
      const { host, token } = await server.ready;
      const machine = `machine=${encodeURIComponent(await runPromise(environmentId(host)))}`;
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
      await expect(browser.locator(`[data-model-slug="${sol}"]`)).toBeVisible();

      await NodeFSP.writeFile(modelsFile, JSON.stringify([sol, astra]));
      await screen.getByRole("button", /refresh provider status|checked just now/i).tap();
      await expect(browser.locator(`[data-model-slug="${astra}"]`)).toBeVisible();
      await expect(browser.locator(`[data-model-slug="${sol}"]`)).toBeVisible();
      await app.screenshot("hosted-models-after-refresh");
    } finally {
      await server.stop();
    }
  },
);
