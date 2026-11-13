// Drives a conn-server binary with Conn's client-runtime pairing and Effect's RpcClient.
// With CONN_MONOREPO set (after `vp i` there): `node <this file> target/debug/conn-server`, or
// `node <this file> target/debug/examples/effect_fixture --fixture` for the ack window.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { importSource, packageImporter } from "../../../tools/monorepo.mjs";

// Packages resolve as packages/contracts sees them, so the sources share one `effect`.
const load = packageImporter("packages/contracts");
const source = importSource;

const DateTime = await load("effect/DateTime");
const Effect = await load("effect/Effect");
const Exit = await load("effect/Exit");
const Layer = await load("effect/Layer");
const Redacted = await load("effect/Redacted");
const Stream = await load("effect/Stream");
const { FetchHttpClient } = await load("effect/http");
const { RpcClient, RpcSerialization } = await load("effect/rpc");
const Socket = await load("effect/socket/Socket");
const { WsRpcGroup } = await source("packages/contracts/src/rpc.ts");
const { joinSocketFrameParts } = await source("packages/shared/src/socketFrameParts.ts");
const { appendOrchestrationProtocol } = await source(
  "packages/client-runtime/src/connection/compatibility.ts",
);
const { fetchRemoteEnvironmentDescriptor } = await source(
  "packages/client-runtime/src/environment/descriptor.ts",
);
const { bootstrapRemoteBearerSession, fetchRemoteSessionState, issueRemoteWebSocketTicket } =
  await source("packages/client-runtime/src/authorization/remote.ts");

const [binary, mode] = process.argv.slice(2);
if (!binary) throw new Error("usage: effect-client.mjs <conn-server binary> [--fixture]");
const fixture = mode === "--fixture";

const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-server-effect-"));
const server = NodeChildProcess.spawn(
  binary,
  fixture ? [stateDir] : ["--listen", "127.0.0.1:0", "--state-dir", stateDir],
  { stdio: ["ignore", "pipe", "pipe"] },
);
const stderr = [];
server.stderr.on("data", (data) => stderr.push(String(data)));
const pairingUrl = await new Promise((resolve, reject) => {
  let out = "";
  server.stdout.on("data", (data) => {
    out += data;
    const match = /pairingUrl: (\S+)/.exec(out);
    if (match) resolve(match[1]);
  });
  server.on("exit", (code) => reject(new Error(`server exited (${code}): ${stderr.join("")}`)));
});
const httpBaseUrl = new URL(pairingUrl).origin;
const credential = new URL(pairingUrl).hash.replace("#token=", "");

const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` -> ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
};

const pairing = Effect.gen(function* () {
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl });
  check("descriptor", descriptor.orchestrationProtocolVersion === 2, descriptor.environmentId);
  const access = yield* bootstrapRemoteBearerSession({ httpBaseUrl, credential });
  check("token exchange", access.token_type === "Bearer", `expires_in ${access.expires_in}`);
  const spent = yield* Effect.exit(bootstrapRemoteBearerSession({ httpBaseUrl, credential }));
  check("pairing code is single use", Exit.isFailure(spent));
  const session = yield* fetchRemoteSessionState({ httpBaseUrl, bearerToken: access.access_token });
  check(
    "session state",
    session.authenticated === true,
    `${session.permissions?.length} permissions`,
  );
  const ticket = yield* issueRemoteWebSocketTicket({
    httpBaseUrl,
    bearerToken: access.access_token,
    use: "rpc",
  });
  return { descriptor, ticket: Redacted.value(ticket.ticket) };
}).pipe(Effect.provide(FetchHttpClient.layer));

const { descriptor, ticket } = await Effect.runPromise(pairing);

const socketUrl = new URL(appendOrchestrationProtocol(`${httpBaseUrl.replace(/^http/, "ws")}/ws`));
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

const take = (stream, n) => Stream.runCollect(Stream.take(stream, n));

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(WsRpcGroup);
  const probe = yield* client["server.probe"]({});
  check("unary server.probe", JSON.stringify(probe) === "{}", JSON.stringify(probe));
  const missing = yield* Effect.exit(client["cloud.getRelayClientStatus"]({}));
  check("unsupported method fails", Exit.isFailure(missing), String(missing.cause).split("\n")[0]);

  const activity = yield* Effect.exit(
    client["server.reportClientActivity"]({
      clientId: "effect-client",
      clientKind: "web",
      visible: true,
      focused: true,
      recentlyInteracted: true,
      scopes: [],
      observedAt: DateTime.makeUnsafe(Date.now()),
    }),
  );
  check("server.reportClientActivity", Exit.isSuccess(activity), String(activity.cause ?? ""));

  if (fixture) {
    const events = yield* take(client.subscribeServerConfig({}), 20);
    check("windowed stream: 20 chunks, window 8", events.length === 20, `${events.length} events`);
    // Stream.take interrupted the subscription; the fixture logs when the server drops it.
    yield* Effect.sleep("200 millis");
    check("interrupt reaches the handler", stderr.join("").includes("stream dropped"));
  } else {
    const [config] = yield* take(client.subscribeServerConfig({}), 1);
    check(
      "subscribeServerConfig snapshot decodes",
      config.type === "snapshot" &&
        config.config.environment.environmentId === descriptor.environmentId,
      `${Object.keys(config.config.settings).length} settings keys`,
    );
    const lifecycle = yield* take(client.subscribeServerLifecycle({}), 2);
    check("subscribeServerLifecycle", lifecycle.map((e) => e.type).join(",") === "welcome,ready");
    const device = yield* take(client.subscribeDeviceState({}), 1);
    check("subscribeDeviceState", device[0].hostStatus === "disabled");
    const terminals = yield* take(client.subscribeTerminalMetadata({}), 1);
    check("subscribeTerminalMetadata", terminals[0].type === "snapshot");
    const clones = yield* take(client.subscribeProjectClones({}), 1);
    check("subscribeProjectClones", Array.isArray(clones[0]));
  }
}).pipe(Effect.scoped, Effect.provide(protocol), Effect.timeout("10 seconds"));

const result = await Effect.runPromiseExit(program);
if (Exit.isFailure(result)) check("rpc session", false, String(result.cause));
server.kill("SIGTERM");
NodeFS.rmSync(stateDir, { recursive: true, force: true });
