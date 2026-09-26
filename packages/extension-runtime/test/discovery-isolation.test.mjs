import * as NodeAssert from "node:assert/strict";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeTest from "node:test";
import { createExtensionRuntime } from "../dist/index.js";
import { FILE_PRESENTATION_API } from "@t3tools/extension-sdk/catalogue";

const grant = "t3.workspace/read-text";
const grants = { capabilities: [grant, "t3.file/open"], projectIds: ["project"] };
const context = {
  resource: { namespace: "test.resource", id: "file", environmentId: "env", projectId: "project" },
  client: "web",
};
const signal = () => new AbortController().signal;
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const method = {
  name: "value",
  inputSchema: { type: "object" },
  outputSchema: { type: "string" },
  effect: "read",
  requiredGrants: [grant],
};
const sharedApi = FILE_PRESENTATION_API;
const sharedResult = (id) =>
  JSON.stringify({ surfaceId: id + "/files", placement: "side-panel", restoreState: {} });
const invokeShared = (f, record) =>
  f.invokeApi(record, sharedApi.id, "open", { relativePath: "README.md" });
const definition = (id) => ({ id: id + "/api", version: "1.0.0", methods: [method] });
function metadata(id, { provides = [definition(id)], requires = [], dependencies = [] } = {}) {
  return {
    format: 2,
    manifest: { id, apiVersion: 1, version: "1.0.0", surfaces: [] },
    serverEntry: "server.mjs",
    tools: [],
    provides,
    requires,
    dependencies,
  };
}
function implementation(pkg, expression = '"value"') {
  return (
    "export default {tools:[],apis:[" +
    pkg.provides
      .map(
        (api) =>
          "{id:" +
          JSON.stringify(api.id) +
          ",methods:[" +
          api.methods
            .map(
              (method) =>
                "{name:" +
                JSON.stringify(method.name) +
                ",invoke:async(input,session)=>{" +
                "return " +
                expression +
                ";}}",
            )
            .join(",") +
          "]}",
      )
      .join(",") +
    "]};"
  );
}
// Two-phase gate: the staged handshake (no marker) completes normally; the real
// worker start (marker present) connects to the entry socket then performs `trap`.
const enteredPath = (directory, name) =>
  NodeProcess.platform === "win32"
    ? "\\\\.\\pipe\\" + NodePath.basename(directory) + "-" + name
    : NodePath.join(directory, "entered-" + name + ".sock");
function gated(pkg, directory, name, trap, expression = '"value"') {
  const marker = JSON.stringify(NodePath.join(directory, "staged-" + name));
  const entered = JSON.stringify(enteredPath(directory, name));
  return (
    'import fs from "node:fs/promises";\nimport net from "node:net";\n' +
    "try { await fs.stat(" +
    marker +
    "); net.connect(" +
    entered +
    ').on("error",()=>{}); ' +
    trap +
    " } " +
    'catch (error) { if(error.code!=="ENOENT") throw error; await fs.writeFile(' +
    marker +
    ',"staged"); }\n' +
    implementation(pkg, expression)
  );
}
// Socket rendezvous, as in capabilities.test.mjs: fs.watch can miss a marker
// file written before its watcher is live, hanging the test until the worker
// hits its startup deadline. A connection to a socket that is already
// listening cannot be missed. Returns { entered } so awaiting this function
// means "listening", not "connected".
async function entrySocket(t, directory, name) {
  const server = NodeNet.createServer();
  t.after(() => server.close());
  const entered = NodeEvents.once(server, "connection");
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(enteredPath(directory, name), resolve);
  });
  return { entered };
}
async function fixture(t, overrides = {}) {
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-discovery-isolation-"),
  );
  const catalogue = { count: 0, waiters: [] };
  const options = {
    rootDir: NodePath.join(directory, "state"),
    environmentId: "env",
    services: [],
    authorize: () => true,
    timeoutMs: 3000,
    onCatalogueChanged: () => {
      catalogue.count++;
      for (const waiter of catalogue.waiters.splice(0)) waiter();
    },
    ...overrides,
  };
  let runtime = await createExtensionRuntime(options);
  t.after(async () => {
    await runtime.dispose();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  });
  let serial = 0;
  const source = async (pkg, code = implementation(pkg)) => {
    const dir = NodePath.join(directory, "source-" + serial++);
    await NodeFSP.mkdir(dir);
    await NodeFSP.writeFile(NodePath.join(dir, "t3-extension.json"), JSON.stringify(pkg));
    await NodeFSP.writeFile(NodePath.join(dir, "server.mjs"), code);
    return dir;
  };
  const install = async (pkg, code, requested = grants) =>
    runtime.install(await source(pkg, code), requested);
  const discover = (record) =>
    runtime.discoverApis(record.id, record.contentHash, context, signal());
  const invokeApi = (record, id, method = "value", input = {}) =>
    runtime.invokeApi(
      record.id,
      record.contentHash,
      { id, versionRange: "^1.0.0", method, input, context },
      signal(),
    );
  return {
    directory,
    source,
    install,
    discover,
    invokeApi,
    catalogue,
    nextCatalogue: () => new Promise((resolve) => catalogue.waiters.push(resolve)),
    get runtime() {
      return runtime;
    },
  };
}

NodeTest.test(
  "discovery resolves while an unrelated provider is still starting",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const blockedPkg = metadata("test.blocked");
    const blocked = await f.install(
      blockedPkg,
      gated(blockedPkg, f.directory, "blocked", "await new Promise(()=>{});"),
    );
    const fastPkg = metadata("test.fast");
    const fast = await f.install(fastPkg);
    const consumerPkg = metadata("test.consumer", {
      provides: [],
      requires: [{ id: fastPkg.provides[0].id, versionRange: "^1" }],
    });
    const consumer = await f.install(consumerPkg);

    const { entered } = await entrySocket(t, f.directory, "blocked");
    const discovery = f.discover(consumer);
    await entered;
    const winner = await Promise.race([
      discovery.then(() => "resolved"),
      f.nextCatalogue().then(() => "invalidated"),
    ]);
    NodeAssert.equal(winner, "resolved");
    const entries = await discovery;
    const blockedEntry = entries.find((entry) => entry.pluginId === blocked.id);
    NodeAssert.equal(blockedEntry.health, "starting");
    const fastEntry = entries.find((entry) => entry.pluginId === fast.id);
    NodeAssert.equal(fastEntry.health, "ready");
    NodeAssert.equal(
      entries.find((entry) => entry.id === fastPkg.provides[0].id).providerId,
      fast.id,
    );
    NodeAssert.equal(await f.invokeApi(consumer, fastPkg.provides[0].id), "value");
  },
);

NodeTest.test(
  "removing an unrelated provider while its start is in flight does not disturb discovery",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const blockedPkg = metadata("test.blocked");
    const blocked = await f.install(
      blockedPkg,
      gated(blockedPkg, f.directory, "blocked", "await new Promise(()=>{});"),
    );
    const fastPkg = metadata("test.fast");
    const fast = await f.install(fastPkg);
    const consumerPkg = metadata("test.consumer", {
      provides: [],
      requires: [{ id: fastPkg.provides[0].id, versionRange: "^1" }],
    });
    const consumer = await f.install(consumerPkg);

    const { entered } = await entrySocket(t, f.directory, "blocked");
    const discovery = f.discover(consumer);
    await entered;
    const entries = await discovery;
    NodeAssert.equal(entries.find((entry) => entry.pluginId === blocked.id).health, "starting");
    await f.runtime.remove(blocked.id);
    NodeAssert.equal(
      f.runtime.catalogue().pluginResolution.some((item) => item.id === blocked.id),
      false,
    );
    const after = await f.discover(consumer);
    NodeAssert.equal(
      after.some((entry) => entry.pluginId === blocked.id),
      false,
    );
    NodeAssert.equal(await f.invokeApi(consumer, fastPkg.provides[0].id), "value");
  },
);

NodeTest.test(
  "a selected provider that fails to start is marked failed and discovery falls back",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const make = async (id, code) => {
      const pkg = metadata(id, { provides: [sharedApi] });
      return { pkg, record: await f.install(pkg, code ?? implementation(pkg, sharedResult(id))) };
    };
    const flakyPkg = metadata("test.flaky", { provides: [sharedApi] });
    const flaky = {
      pkg: flakyPkg,
      record: await f.install(
        flakyPkg,
        gated(
          flakyPkg,
          f.directory,
          "flaky",
          'throw new Error("startup boom");',
          sharedResult("test.flaky"),
        ),
      ),
    };
    const steady = await make("test.steady");
    const consumerPkg = metadata("test.consumer", {
      provides: [],
      requires: [{ id: sharedApi.id, versionRange: "^1" }],
    });
    const consumer = await f.install(consumerPkg);
    await f.runtime.selectApi({
      id: sharedApi.id,
      providerId: flaky.record.id,
      fallbackProviderIds: [steady.record.id],
    });

    const { entered } = await entrySocket(t, f.directory, "flaky");
    const discovery = f.discover(consumer);
    await entered;
    const entries = await discovery;
    NodeAssert.equal(
      f.runtime.catalogue().pluginResolution.find((item) => item.id === flaky.record.id).status,
      "unavailable",
    );
    const resolved = entries.find((entry) => entry.id === sharedApi.id && entry.selected);
    NodeAssert.equal(resolved.providerId, steady.record.id);
    NodeAssert.equal((await invokeShared(f, consumer)).surfaceId, "test.steady/files");
  },
);

NodeTest.test(
  "selection changes apply while an unrelated provider is still starting",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const blockedPkg = metadata("test.blocked");
    await f.install(
      blockedPkg,
      gated(blockedPkg, f.directory, "blocked", "await new Promise(()=>{});"),
    );
    const make = async (id) => {
      const pkg = metadata(id, { provides: [sharedApi] });
      return f.install(pkg, implementation(pkg, sharedResult(id)));
    };
    const first = await make("test.first");
    const second = await make("test.second");
    const consumerPkg = metadata("test.consumer", {
      provides: [],
      requires: [{ id: sharedApi.id, versionRange: "^1" }],
    });
    const consumer = await f.install(consumerPkg);
    await f.runtime.selectApi({
      id: sharedApi.id,
      providerId: first.id,
      fallbackProviderIds: [second.id],
    });

    const { entered } = await entrySocket(t, f.directory, "blocked");
    const discovery = f.discover(consumer);
    await entered;
    const entries = await discovery;
    NodeAssert.equal(
      entries.find((entry) => entry.id === sharedApi.id && entry.selected).providerId,
      first.id,
    );
    await f.runtime.selectApi({
      id: sharedApi.id,
      providerId: second.id,
      fallbackProviderIds: [first.id],
    });
    const after = await f.discover(consumer);
    NodeAssert.equal(
      after.find((entry) => entry.id === sharedApi.id && entry.selected).providerId,
      second.id,
    );
    NodeAssert.equal((await invokeShared(f, consumer)).surfaceId, "test.second/files");
  },
);
