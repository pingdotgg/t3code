// Settings secrets across the two servers: the T3 server's own settings service
// (`apps/server/src/serverSettings.ts` with its `ServerSecretStore`) and this server, on the
// same state folders. Each server must read every secret the other stored, and no secret may
// be lost or written to `settings.json` in clear text.
//
//   node crates/conn-server/tools/secrets-interop.mjs <release dir>
//
// `<release dir>` holds `conn-server` and `examples/settings_secrets`. The second opens a state
// folder as the server does at start and compares what it reads with the expected values (it
// prints paths, never values). No model, no outside service: a loopback stub stands in for a
// text generator. Every state folder is a fresh temp folder.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { importSource, packageImporter } from "../../../tools/monorepo.mjs";
import { sealedEnv } from "../../../tools/sealed-env.mjs";

const loadServer = packageImporter("apps/server");
const loadContracts = packageImporter("packages/contracts");
const Effect = await loadServer("effect/Effect");
const Layer = await loadServer("effect/Layer");
const NodeServices = await loadServer("@effect/platform-node/NodeServices");
const NodeCrypto = await loadServer("@effect/platform-node/NodeCrypto");
const Exit = await loadContracts("effect/Exit");
const Redacted = await loadContracts("effect/Redacted");
const { FetchHttpClient } = await loadContracts("effect/http");
const { RpcClient, RpcSerialization } = await loadContracts("effect/rpc");
const Socket = await loadContracts("effect/socket/Socket");
const ServerSecretStore = await importSource("apps/server/src/auth/ServerSecretStore.ts");
const ServerConfig = await importSource("apps/server/src/config.ts");
const Sqlite = await importSource("apps/server/src/persistence/Sqlite.ts");
const ManagedPolicy = await importSource("apps/server/src/policy/ManagedPolicy.ts");
const T3Settings = await importSource("apps/server/src/serverSettings.ts");
const { WsRpcGroup } = await importSource("packages/contracts/src/rpc.ts");
const { joinSocketFrameParts } = await importSource("packages/shared/src/socketFrameParts.ts");
const { appendOrchestrationProtocol } = await importSource(
  "packages/client-runtime/src/connection/compatibility.ts",
);
const { bootstrapRemoteBearerSession, issueRemoteWebSocketTicket } = await importSource(
  "packages/client-runtime/src/authorization/remote.ts",
);

const [releaseDir] = process.argv.slice(2);
if (!releaseDir) throw new Error("usage: secrets-interop.mjs <release dir>");
const binary = NodePath.resolve(releaseDir, "conn-server");
const reader = NodePath.resolve(releaseDir, "examples/settings_secrets");
const MARKER = "•".repeat(6);

// A loopback stub that records the key a text generator request carries.
const seenKeys = [];
const stub = NodeHttp.createServer((request, response) => {
  seenKeys.push(request.headers.authorization ?? null);
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ object: "list", data: [{ id: "stub-model", object: "model" }] }));
});
await new Promise((ok) => stub.listen(0, "127.0.0.1", ok));
const stubUrl = `http://127.0.0.1:${stub.address().port}/v1`;

/** Settings with one secret of every kind, as values the test owns. */
function secretSettings(tag) {
  return {
    providerInstances: {
      oc: {
        driver: "opencode",
        config: { serverPassword: `pw-${tag}` },
        environment: [
          { name: "OC_KEY", value: `env-${tag}`, sensitive: true },
          { name: "MODE", value: "plain", sensitive: false },
        ],
      },
    },
    textGenerators: {
      tg: { kind: "openaiCompatible", label: "Stub", baseUrl: stubUrl, apiKey: `tg-${tag}`, enabled: true },
    },
    sourceControlHosts: {
      github: { tokens: { "github.com": `ghp-${tag}` } },
    },
    cloudSpeechCredentials: { openai: `voice-${tag}` },
    usageLimitSources: {
      u: { kind: "cliproxy", url: "http://127.0.0.1:9", managementKey: `mk-${tag}`, enabled: true },
    },
    easDeviceHosts: [
      {
        kind: "eas",
        id: "eas1",
        label: "EAS",
        accessToken: `eas-${tag}`,
        maxSessionMinutes: 30,
        idleMinutes: 10,
        maxConcurrentSessions: 2,
      },
    ],
    simlockDeviceHosts: [
      {
        kind: "simlock",
        id: "sim1",
        label: "Sim",
        gatewayUrl: "http://127.0.0.1:9",
        agentToken: `sim-${tag}`,
        maxLeases: 2,
        maxLeaseMinutes: 60,
      },
    ],
  };
}

/** The secret values of `secretSettings(tag)`, by path, as a server must read them. */
function expectedSecrets(tag) {
  return {
    providerInstances: {
      oc: {
        config: { serverPassword: `pw-${tag}` },
        environment: [{ name: "OC_KEY", value: `env-${tag}` }, { name: "MODE", value: "plain" }],
      },
    },
    textGenerators: { tg: { apiKey: `tg-${tag}` } },
    sourceControlHosts: {
      github: { tokens: { "github.com": `ghp-${tag}` } },
    },
    cloudSpeechCredentials: { openai: `voice-${tag}` },
    usageLimitSources: { u: { managementKey: `mk-${tag}` } },
    easDeviceHosts: [{ accessToken: `eas-${tag}` }],
    simlockDeviceHosts: [{ agentToken: `sim-${tag}` }],
  };
}

const secretValues = (tag) =>
  [`pw-${tag}`, `env-${tag}`, `tg-${tag}`, `ghp-${tag}`, `voice-${tag}`, `mk-${tag}`, `eas-${tag}`, `sim-${tag}`];

/** A T3 home: the state folder is `<base>/userdata`, as `deriveServerPaths` makes it. */
function newHome() {
  const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-secrets-interop-"));
  const state = NodePath.join(base, "userdata");
  NodeFS.mkdirSync(state);
  return { base, state };
}

/** Runs `use` with the T3 server's settings service on `home`. */
function withT3(home, use) {
  const layer = T3Settings.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), home.base)),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* T3Settings.ServerSettingsService;
      yield* service.start;
      return yield* use(service);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
}

/** The paths where `actual` does not hold `expected`'s leaves (no values printed). */
function differs(expected, actual, path = "", out = []) {
  if (expected !== null && typeof expected === "object") {
    for (const key of Object.keys(expected)) differs(expected[key], actual?.[key], `${path}.${key}`, out);
  } else if (expected !== actual) {
    out.push(path);
  }
  return out;
}

/** Problems with the files: a secret value in `settings.json`, or a mode that is not private. */
function fileProblems(home, tag, { loadOnly = false } = {}) {
  const problems = [];
  const text = NodeFS.readFileSync(NodePath.join(home.state, "settings.json"), "utf8");
  // A start moves field secrets only; a variable moves on the next save (both servers).
  const values = secretValues(tag).filter((v) => !(loadOnly && v === `env-${tag}`));
  for (const value of values) {
    if (text.includes(value)) problems.push(`settings.json holds a secret in clear text`);
  }
  const secrets = NodePath.join(home.state, "secrets");
  if ((NodeFS.statSync(secrets).mode & 0o777) !== 0o700) problems.push("secrets/ is not 0700");
  for (const name of NodeFS.readdirSync(secrets)) {
    if ((NodeFS.statSync(NodePath.join(secrets, name)).mode & 0o777) !== 0o600) {
      problems.push(`secrets/${name} is not 0600`);
    }
  }
  return [...new Set(problems)];
}

/** What this server reads from `home` at start (inline secrets move first). */
function connReads(home, tag) {
  const run = NodeChildProcess.spawnSync(reader, [home.state], {
    input: JSON.stringify(expectedSecrets(tag)),
    encoding: "utf8",
    env: sealedEnv(home.base),
  });
  return run.status === 0 ? [] : [`conn-server reads: ${run.stdout.trim() || run.stderr.trim()}`];
}

async function t3Reads(home, tag) {
  const settings = await withT3(home, (service) => service.getSettings);
  return differs(expectedSecrets(tag), settings).map((path) => `T3 reads ${path} differently`);
}

async function withConn(home, use) {
  const server = NodeChildProcess.spawn(binary, ["--listen", "127.0.0.1:0", "--state-dir", home.state], {
    cwd: home.base,
    stdio: ["ignore", "pipe", "pipe"],
    env: sealedEnv(home.base),
  });
  const stderr = [];
  server.stderr.on("data", (d) => stderr.push(String(d)));
  try {
    const pairingUrl = await new Promise((ok, fail) => {
      let out = "";
      server.stdout.on("data", (d) => {
        out += d;
        const match = /pairingUrl: (\S+)/.exec(out);
        if (match) ok(match[1]);
      });
      server.on("exit", (code) => fail(new Error(`conn-server exited (${code}): ${stderr.join("")}`)));
    });
    const url = new URL(pairingUrl);
    const origin = url.origin;
    const ticket = await Effect.runPromise(
      Effect.gen(function* () {
        const access = yield* bootstrapRemoteBearerSession({
          httpBaseUrl: origin,
          credential: url.hash.replace("#token=", ""),
        });
        const issued = yield* issueRemoteWebSocketTicket({
          httpBaseUrl: origin,
          bearerToken: access.access_token,
          use: "rpc",
        });
        return Redacted.value(issued.ticket);
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    );
    const socketUrl = new URL(appendOrchestrationProtocol(`${origin.replace(/^http/, "ws")}/ws`));
    socketUrl.searchParams.set("wsTicket", ticket);
    socketUrl.searchParams.set("frameParts", "1");
    const protocol = RpcClient.layerProtocolSocket().pipe(
      Layer.provide(
        Layer.effect(Socket.Socket, Effect.map(Effect.service(Socket.Socket), joinSocketFrameParts)).pipe(
          Layer.provide(Socket.layerWebSocket(socketUrl.toString())),
        ),
      ),
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
      Layer.provide(RpcSerialization.layerJson),
    );
    const call = (tag, payload) =>
      Effect.runPromiseExit(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(WsRpcGroup);
          return yield* client[tag](payload);
        }).pipe(Effect.scoped, Effect.provide(protocol), Effect.timeout("15 seconds")),
      ).then((exit) => {
        if (Exit.isFailure(exit)) throw new Error(`${tag} failed: ${String(exit.cause).split("\n")[0]}`);
        return exit.value;
      });
    return await use(call);
  } finally {
    if (server.exitCode === null) server.kill("SIGTERM");
    await new Promise((r) => (server.exitCode === null ? server.once("exit", r) : r()));
  }
}

/** No answer to a client may hold a secret value. */
function leaks(answer, tag) {
  const text = JSON.stringify(answer);
  return secretValues(tag).filter((v) => text.includes(v)).map(() => "a client answer holds a secret");
}

const cases = [
  {
    name: "a folder this server wrote before the store (inline secrets): T3 reads it",
    async run() {
      const home = newHome();
      NodeFS.writeFileSync(NodePath.join(home.state, "settings.json"), JSON.stringify(secretSettings("a")));
      return { home, problems: [...(await t3Reads(home, "a")), ...fileProblems(home, "a", { loadOnly: true })] };
    },
  },
  {
    name: "the same folder after this server starts on it: secrets moved, T3 reads them",
    async run() {
      const home = newHome();
      NodeFS.writeFileSync(NodePath.join(home.state, "settings.json"), JSON.stringify(secretSettings("b")));
      const problems = connReads(home, "b");
      problems.push(...fileProblems(home, "b", { loadOnly: true }), ...(await t3Reads(home, "b")));
      return { home, problems };
    },
  },
  {
    name: "secrets this server saves through server.updateSettings: T3 reads them",
    async run() {
      const home = newHome();
      const problems = [];
      await withConn(home, async (call) => {
        const answer = await call("server.updateSettings", { patch: secretSettings("c") });
        problems.push(...leaks(answer, "c"));
        if (answer.textGenerators.tg.apiKey !== MARKER) problems.push("the answer does not show the marker");
      });
      problems.push(...fileProblems(home, "c"), ...connReads(home, "c"), ...(await t3Reads(home, "c")));
      return { home, problems };
    },
  },
  {
    name: "secrets the T3 server saved: this server reads them, keeps them on a save, and T3 still reads them",
    async run() {
      const home = newHome();
      const problems = [];
      await withT3(home, (service) => service.updateSettings(secretSettings("d")));
      problems.push(...fileProblems(home, "d"), ...connReads(home, "d"));
      seenKeys.length = 0;
      await withConn(home, async (call) => {
        // The text generator's key reaches the endpoint: this server read T3's store.
        await call("server.listTextGeneratorModels", { id: "tg" });
        if (!seenKeys.includes("Bearer tg-d")) problems.push("the text generator request did not carry T3's key");
        // A client edits other settings and echoes what it was shown.
        const view = await call("server.updateSettings", { patch: { enableAgentBrowserAccess: false } });
        problems.push(...leaks(view, "d"));
        await call("server.updateSettings", {
          patch: {
            providerInstances: view.providerInstances,
            textGenerators: view.textGenerators,
            sourceControlHosts: view.sourceControlHosts,
          },
        });
      });
      problems.push(...fileProblems(home, "d"), ...connReads(home, "d"), ...(await t3Reads(home, "d")));
      return { home, problems };
    },
  },
  {
    name: "the T3 server saves over this server's folder: this server reads the new values",
    async run() {
      const home = newHome();
      const problems = [];
      await withConn(home, (call) => call("server.updateSettings", { patch: secretSettings("e") }));
      await withT3(home, (service) => service.updateSettings(secretSettings("f")));
      problems.push(...fileProblems(home, "f"), ...connReads(home, "f"));
      return { home, problems };
    },
  },
];

let failed = 0;
for (const testCase of cases) {
  let result;
  try {
    result = await testCase.run();
  } catch (error) {
    result = { problems: [String(error.message).split("\n")[0]] };
  }
  if (result.home) NodeFS.rmSync(result.home.base, { recursive: true, force: true });
  if (result.problems.length === 0) {
    console.log(`ok   ${testCase.name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${testCase.name}`);
    for (const problem of result.problems) console.log(`       ${problem}`);
  }
}
stub.close();
console.log(failed === 0 ? `\n${cases.length} cases: both servers read each other's secrets` : `\n${failed} of ${cases.length} cases failed`);
process.exitCode = failed === 0 ? 0 : 1;
