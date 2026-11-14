// Settings differential check: the same stored settings and patch go through the T3 server's
// own functions and through a conn-server binary, and the results must agree.
//
//   CONN_MONOREPO=<conn checkout> node crates/conn-server/tools/settings-diff.mjs <conn-server binary>
//
// For each case in settings-cases.json, on a fresh temp state folder:
// - conn-server: settings.json holds `stored`; the tool pairs, calls `server.updateSettings`
//   over /ws with the real client, and reads settings.json back.
// - T3: `applyServerSettingsPatch` (packages/shared), `applyProviderInstanceMutation` and
//   `redactServerSettingsForClient` (apps/server/src/serverSettings.ts), with secrets that a
//   client echoed as `••••••` kept from the stored settings, as `persistSettingsSecrets` does
//   (through `mapSettingsSecrets`, apps/server/src/settingsSecrets.ts).
// It compares the client view (the answer) and the stored settings, each decoded as
// `ServerSettings` and encoded back, so defaults and key order do not count. A patch the T3
// schema rejects must be refused. Not modelled: `normalizeServerSettings` (enabled flags,
// idle compaction, legacy override derivation), managed policy. The stored file is compared in
// its T3 form (`••••••` where a secret went to the store); `secrets-interop.mjs` runs the T3
// server's own settings service on the store itself.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { importSource, packageImporter } from "../../../tools/monorepo.mjs";

const load = packageImporter("packages/contracts");
const Effect = await load("effect/Effect");
const Exit = await load("effect/Exit");
const Layer = await load("effect/Layer");
const Redacted = await load("effect/Redacted");
const Schema = await load("effect/Schema");
const { FetchHttpClient } = await load("effect/http");
const { RpcClient, RpcSerialization } = await load("effect/rpc");
const Socket = await load("effect/socket/Socket");
const contracts = await importSource("packages/contracts/src/index.ts");
const { WsRpcGroup } = await importSource("packages/contracts/src/rpc.ts");
const { joinSocketFrameParts } = await importSource("packages/shared/src/socketFrameParts.ts");
const { appendOrchestrationProtocol } = await importSource(
  "packages/client-runtime/src/connection/compatibility.ts",
);
const { bootstrapRemoteBearerSession, issueRemoteWebSocketTicket } = await importSource(
  "packages/client-runtime/src/authorization/remote.ts",
);
const shared = await importSource("packages/shared/src/serverSettings.ts");
const t3 = await importSource("apps/server/src/serverSettings.ts");
const secrets = await importSource("apps/server/src/settingsSecrets.ts");

const [binary] = process.argv.slice(2);
if (!binary) throw new Error("usage: settings-diff.mjs <conn-server binary>");
const cases = JSON.parse(
  NodeFS.readFileSync(new URL("settings-cases.json", import.meta.url), "utf8"),
).cases;

const settingsCodec = Schema.toCodecJson(contracts.ServerSettings);
const decodeSettings = Schema.decodeUnknownSync(settingsCodec);
const encodeSettings = Schema.encodeSync(settingsCodec);
// server.updateSettings decodes ClientServerSettingsPatch (no theme defaults).
const decodePatch = Schema.decodeUnknownSync(Schema.toCodecJson(contracts.ClientServerSettingsPatch));
const decodeMutation = Schema.decodeUnknownSync(
  Schema.toCodecJson(contracts.ProviderInstanceMutation),
);
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical(value[k])]),
        )
      : value;
/** Decoded as ServerSettings and encoded back: the shape both servers mean. */
const normal = (settings) => canonical(encodeSettings(decodeSettings(settings)));

/** What the T3 server answers and stores for `stored` + `patch` (+ `mutation`). */
function t3Result(stored, patch, mutation) {
  let decodedPatch;
  let decodedMutation;
  try {
    decodedPatch = decodePatch(patch);
    decodedMutation = mutation === undefined ? undefined : decodeMutation(mutation);
  } catch (error) {
    return { refused: `the patch does not decode: ${String(error.message).split("\n")[0]}` };
  }
  const current = decodeSettings(stored);
  if (
    decodedMutation?.operation === "create" &&
    Object.hasOwn(current.providerInstances, decodedMutation.instanceId)
  ) {
    return { refused: "create-provider-instance" };
  }
  let next = shared.applyServerSettingsPatch(current, decodedPatch);
  if (decodedMutation !== undefined) next = t3.applyProviderInstanceMutation(next, decodedMutation);
  // persistSettingsSecrets: a secret a client echoed as the marker keeps its stored value.
  const kept = new Map();
  secrets.mapSettingsSecrets(current, (secret) => {
    if (secret.sensitive && !secret.redacted && secret.value.length > 0) {
      kept.set(secret.secretName, secret.value);
    }
    return secret;
  });
  next = secrets.mapSettingsSecrets(next, (secret) =>
    secret.redacted && kept.has(secret.secretName)
      ? { value: kept.get(secret.secretName), redacted: false }
      : { value: secret.value, redacted: secret.redacted },
  );
  // The file holds the marker where a value went to the secret store (persistSettingsSecrets);
  // a cleared or non-sensitive slot holds its value.
  const filed = secrets.mapSettingsSecrets(next, (secret) =>
    !secret.sensitive
      ? { value: secret.value, redacted: false }
      : secret.redacted || secret.value.length > 0
        ? { value: "", redacted: true }
        : { value: "", redacted: false },
  );
  return {
    stored: normal(encodeSettings(filed)),
    view: normal(encodeSettings(t3.redactServerSettingsForClient(next, { secretReferences: false }))),
  };
}

async function startServer(stored) {
  const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-settings-diff-"));
  const stateDir = NodePath.join(tmp, "state");
  NodeFS.mkdirSync(stateDir);
  NodeFS.writeFileSync(NodePath.join(stateDir, "settings.json"), `${JSON.stringify(stored)}\n`);
  const server = NodeChildProcess.spawn(
    NodePath.resolve(binary),
    ["--listen", "127.0.0.1:0", "--state-dir", stateDir],
    { cwd: tmp, stdio: ["ignore", "pipe", "pipe"] },
  );
  const stderr = [];
  server.stderr.on("data", (d) => stderr.push(String(d)));
  const pairingUrl = await new Promise((ok, fail) => {
    let out = "";
    server.stdout.on("data", (d) => {
      out += d;
      const match = /pairingUrl: (\S+)/.exec(out);
      if (match) ok(match[1]);
    });
    server.on("exit", (code) => fail(new Error(`server exited (${code}): ${stderr.join("")}`)));
  });
  const url = new URL(pairingUrl);
  return {
    origin: url.origin,
    credential: url.hash.replace("#token=", ""),
    settingsFile: NodePath.join(stateDir, "settings.json"),
    stop: async () => {
      if (server.exitCode === null) server.kill("SIGTERM");
      await new Promise((r) => (server.exitCode === null ? server.once("exit", r) : r()));
      NodeFS.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** conn-server's answer to the update, and what it stored. */
async function connResult(stored, patch, mutation) {
  const server = await startServer(stored);
  try {
    const ticket = await Effect.runPromise(
      Effect.gen(function* () {
        const access = yield* bootstrapRemoteBearerSession({
          httpBaseUrl: server.origin,
          credential: server.credential,
        });
        const issued = yield* issueRemoteWebSocketTicket({
          httpBaseUrl: server.origin,
          bearerToken: access.access_token,
          use: "rpc",
        });
        return Redacted.value(issued.ticket);
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    );
    const socketUrl = new URL(
      appendOrchestrationProtocol(`${server.origin.replace(/^http/, "ws")}/ws`),
    );
    socketUrl.searchParams.set("wsTicket", ticket);
    socketUrl.searchParams.set("frameParts", "1");
    const protocol = RpcClient.layerProtocolSocket().pipe(
      Layer.provide(
        Layer.effect(
          Socket.Socket,
          Effect.map(Effect.service(Socket.Socket), joinSocketFrameParts),
        ).pipe(Layer.provide(Socket.layerWebSocket(socketUrl.toString()))),
      ),
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
      Layer.provide(RpcSerialization.layerJson),
    );
    // The client encodes the payload with its own schema; send what it would send.
    const payload = {
      patch: decodePatch(patch),
      ...(mutation === undefined ? {} : { providerInstanceMutation: decodeMutation(mutation) }),
    };
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(WsRpcGroup);
        return yield* client["server.updateSettings"](payload);
      }).pipe(Effect.scoped, Effect.provide(protocol), Effect.timeout("10 seconds")),
    );
    if (Exit.isFailure(exit)) {
      return { refused: String(exit.cause).split("\n")[0].slice(0, 200) };
    }
    const onDisk = JSON.parse(NodeFS.readFileSync(server.settingsFile, "utf8"));
    let storedNormal;
    try {
      storedNormal = normal(onDisk);
    } catch (error) {
      storedNormal = { undecodable: String(error.message).split("\n")[0] };
    }
    return { stored: storedNormal, view: normal(encodeSettings(exit.value)) };
  } finally {
    await server.stop();
  }
}

/** Sends `server.updateSettings` as a raw frame, as a client with another schema could. */
async function rawUpdate(stored, patch) {
  const server = await startServer(stored);
  try {
    const ticket = await Effect.runPromise(
      Effect.gen(function* () {
        const access = yield* bootstrapRemoteBearerSession({
          httpBaseUrl: server.origin,
          credential: server.credential,
        });
        const issued = yield* issueRemoteWebSocketTicket({
          httpBaseUrl: server.origin,
          bearerToken: access.access_token,
          use: "rpc",
        });
        return Redacted.value(issued.ticket);
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    );
    const url = new URL(appendOrchestrationProtocol(`${server.origin.replace(/^http/, "ws")}/ws`));
    url.searchParams.set("wsTicket", ticket);
    const answer = await new Promise((ok, fail) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => fail(new Error("no answer")), 10000);
      socket.onopen = () =>
        socket.send(
          JSON.stringify({
            _tag: "Request",
            id: "1",
            tag: "server.updateSettings",
            payload: { patch },
            headers: [],
          }),
        );
      socket.onmessage = (event) => {
        const frames = [].concat(JSON.parse(String(event.data)));
        const exit = frames.find((f) => f._tag === "Exit");
        if (exit) {
          clearTimeout(timer);
          socket.close();
          ok(exit.exit);
        }
      };
      socket.onerror = () => fail(new Error("socket error"));
    });
    const onDisk = JSON.parse(NodeFS.readFileSync(server.settingsFile, "utf8"));
    let decodes = true;
    try {
      decodeSettings(onDisk);
    } catch {
      decodes = false;
    }
    return { success: answer?._tag === "Success", storedDecodes: decodes };
  } finally {
    await server.stop();
  }
}

/** The paths where two JSON values differ, at most `max`. */
function differences(a, b, path = "", out = [], max = 12) {
  if (out.length >= max) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      differences(a[key], b[key], `${path}.${key}`, out, max);
    }
    return out;
  }
  out.push(`${path || "."}: T3 ${JSON.stringify(a)?.slice(0, 120)} | conn ${JSON.stringify(b)?.slice(0, 120)}`);
  return out;
}

let failed = 0;
for (const testCase of cases) {
  const { name, stored, patch, mutation } = testCase;
  let expected;
  try {
    expected = t3Result(stored, patch, mutation);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: the case is invalid for the T3 server: ${String(error.message).split("\n").slice(0, 2).join(" ")}`);
    continue;
  }
  let problems = [];
  if (expected.refused !== undefined && expected.refused.startsWith("the patch does not decode")) {
    // A real client cannot send it; a raw frame can. It must be refused and change nothing.
    const raw = await rawUpdate(stored, patch);
    if (raw.success) problems.push(`T3 refuses (${expected.refused}); conn-server accepted it`);
    if (!raw.storedDecodes) problems.push("conn-server stored settings that no longer decode");
  } else {
    const actual = await connResult(stored, patch, mutation);
    if (expected.refused !== undefined) {
      if (actual.refused === undefined) problems.push(`T3 refuses (${expected.refused}); conn-server accepted it`);
    } else if (actual.refused !== undefined) {
      problems.push(`conn-server refused: ${actual.refused}`);
    } else {
      problems = [
        ...differences(expected.view, actual.view).map((d) => `view ${d}`),
        ...differences(expected.stored, actual.stored).map((d) => `stored ${d}`),
      ];
    }
  }
  // A case may list paths that are known to differ (a rule not ported yet); they print, but
  // the case passes only when every difference is under one of them.
  const known = testCase.known ?? [];
  const isKnown = (problem) => known.some((path) => problem.startsWith(`view ${path}`) || problem.startsWith(`stored ${path}`));
  if (problems.length > 0 && known.length > 0 && problems.every(isKnown)) {
    console.log(`ok   ${name} (known difference: ${testCase.knownWhy ?? known.join(", ")})`);
  } else if (problems.length === 0) {
    if (known.length > 0) {
      failed += 1;
      console.log(`FAIL ${name}: no longer differs; remove "known" from the case`);
      continue;
    }
    console.log(`ok   ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}`);
    for (const problem of problems) console.log(`       ${problem}`);
  }
}
console.log(failed === 0 ? `\n${cases.length} cases agree with the T3 server` : `\n${failed} of ${cases.length} cases differ`);
process.exitCode = failed === 0 ? 0 : 1;
