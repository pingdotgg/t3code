// Replays fixtures/sessions/<scenario>.ndjson against a conn-server binary through Effect's
// RpcClient and checks every answer decodes or is the explicit not-supported defect.
// With CONN_MONOREPO set: node <this file> target/debug/examples/replay_server [scenario...].
// `replay_server` runs the engine's fake provider, so no model is called.
// With DECODE_COVERAGE=<file>, appends each tag whose answer decoded (a value, a first stream
// item, a stream that ended, or a typed error) for decode-coverage.mjs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { importSource, packageImporter } from "../../../tools/monorepo.mjs";
import { sealedEnv } from "../../../tools/sealed-env.mjs";

// Packages resolve as packages/contracts sees them, so the sources share one `effect`.
const load = packageImporter("packages/contracts");
const source = importSource;

const Effect = await load("effect/Effect");
const Exit = await load("effect/Exit");
const Layer = await load("effect/Layer");
const Option = await load("effect/Option");
const Redacted = await load("effect/Redacted");
const Schema = await load("effect/Schema");
const Stream = await load("effect/Stream");
const { FetchHttpClient } = await load("effect/http");
const { RpcClient, RpcSchema, RpcSerialization } = await load("effect/rpc");
const Socket = await load("effect/socket/Socket");
const { WsRpcGroup } = await source("packages/contracts/src/rpc.ts");
const { joinSocketFrameParts } = await source("packages/shared/src/socketFrameParts.ts");
const { appendOrchestrationProtocol } = await source(
  "packages/client-runtime/src/connection/compatibility.ts",
);
const { bootstrapRemoteBearerSession, issueRemoteWebSocketTicket } = await source(
  "packages/client-runtime/src/authorization/remote.ts",
);

const [binary, ...named] = process.argv.slice(2);
if (!binary) throw new Error("usage: replay.mjs <conn-server binary> [scenario...]");
const scenarios = named.length > 0 ? named : ["remote", "turn"];
const sessions = new URL("../../../fixtures/sessions/", import.meta.url);

const payloadDecoders = new Map();
const decodePayload = (tag, schema) => {
  let decode = payloadDecoders.get(tag);
  if (decode === undefined) {
    decode = Schema.decodeUnknownEffect(Schema.toCodecJson(schema));
    payloadDecoders.set(tag, decode);
  }
  return decode;
};

const STREAM_WAIT = "1500 millis";
const UNARY_WAIT = "10 seconds";

/** Starts the server on a scratch project and returns its origin and pairing code. */
async function start() {
  const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-replay-"));
  const project = NodePath.join(tmp, "project");
  NodeFS.mkdirSync(project);
  NodeChildProcess.execFileSync("git", ["init", "-q", "-b", "main"], { cwd: project });
  const server = NodeChildProcess.spawn(
    binary,
    // Its own free port: the default port is taken when another check runs beside this one.
    ["--listen", "127.0.0.1:0", "--state-dir", NodePath.join(tmp, "state"), "--project", project],
    { stdio: ["ignore", "pipe", "pipe"], env: sealedEnv(tmp) },
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
    stop: () => {
      server.kill("SIGTERM");
      NodeFS.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** The recorded client requests, in order, across every socket of the scenario. */
function recordedRequests(scenario) {
  const lines = NodeFS.readFileSync(new URL(`${scenario}.ndjson`, sessions), "utf8").split("\n");
  return lines
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
    .filter((line) => line.dir === "in" && line.frame._tag === "Request")
    .map((line) => line.frame);
}

/** Recorded ids name the TypeScript server's project; point them at ours. */
function retarget(value, projectId) {
  if (Array.isArray(value)) return value.map((v) => retarget(v, projectId));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      key,
      key === "projectId" && typeof v === "string" ? projectId : retarget(v, projectId),
    ]),
  );
}

function classify(exit) {
  if (Exit.isSuccess(exit)) return { kind: "ok" };
  const reasons = exit.cause.reasons;
  if (reasons.every((r) => r._tag === "Interrupt")) return { kind: "interrupted" };
  const fail = reasons.find((r) => r._tag === "Fail");
  if (fail) {
    const tag = fail.error?._tag;
    // A timeout is ours, not the server's.
    if (tag === "TimeoutError") return { kind: "BAD", detail: "no answer in time" };
    return { kind: "typed-error", detail: tag ?? String(fail.error) };
  }
  const die = reasons.find((r) => r._tag === "Die");
  if (die?.defect?.name === "ConnServerNotSupported") return { kind: "not-supported" };
  return { kind: "BAD", detail: String(die?.defect ?? exit.cause).split("\n")[0] };
}

async function replay(scenario) {
  const server = await start();
  try {
    const pairing = Effect.gen(function* () {
      const access = yield* bootstrapRemoteBearerSession({
        httpBaseUrl: server.origin,
        credential: server.credential,
      });
      const ticket = yield* issueRemoteWebSocketTicket({
        httpBaseUrl: server.origin,
        bearerToken: access.access_token,
        use: "rpc",
      });
      return Redacted.value(ticket.ticket);
    }).pipe(Effect.provide(FetchHttpClient.layer));
    const ticket = await Effect.runPromise(pairing);

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

    const program = Effect.gen(function* () {
      const client = yield* RpcClient.make(WsRpcGroup);
      // The project id the engine gives our scratch folder, as the client learns it.
      const [shell] = yield* Stream.runCollect(
        Stream.take(client["orchestration.subscribeShell"]({ requestCompletionMarker: true }), 1),
      );
      const projectId = shell.snapshot.projects[0]?.id;
      const results = [];
      for (const request of recordedRequests(scenario)) {
        const rpc = WsRpcGroup.requests.get(request.tag);
        if (rpc === undefined) {
          results.push({ tag: request.tag, kind: "BAD", detail: "not in the contract" });
          continue;
        }
        const payload = yield* Effect.exit(
          decodePayload(request.tag, rpc.payloadSchema)(retarget(request.payload, projectId)),
        );
        if (Exit.isFailure(payload)) {
          results.push({
            tag: request.tag,
            kind: "BAD",
            detail: "recorded payload no longer decodes",
          });
          continue;
        }
        const stream = RpcSchema.isStreamSchema(rpc.successSchema);
        let result;
        if (stream) {
          const first = yield* Effect.exit(
            Stream.runHead(client[request.tag](payload.value)).pipe(
              Effect.timeoutOption(STREAM_WAIT),
            ),
          );
          if (Exit.isSuccess(first)) {
            // Some: an item decoded. None twice over: open, nothing yet (or ended empty).
            const item = first.value;
            result =
              Option.isSome(item) && Option.isSome(item.value)
                ? { kind: "ok", detail: "first item" }
                : { kind: "ok", detail: Option.isNone(item) ? "open, no item yet" : "ended empty" };
          } else {
            result = classify(first);
          }
        } else {
          result = classify(
            yield* Effect.exit(client[request.tag](payload.value).pipe(Effect.timeout(UNARY_WAIT))),
          );
        }
        results.push({ tag: request.tag, stream, ...result });
      }
      return results;
    }).pipe(Effect.scoped, Effect.provide(protocol));
    return await Effect.runPromise(program);
  } finally {
    server.stop();
  }
}

let bad = 0;
const implemented = new Set();
const decodedTags = new Set();
const missing = new Set();
for (const scenario of scenarios) {
  const results = await replay(scenario);
  const byTag = new Map();
  for (const r of results) {
    const entry = byTag.get(r.tag) ?? { stream: r.stream, kinds: new Map() };
    const key = r.detail ? `${r.kind} (${r.detail})` : r.kind;
    entry.kinds.set(key, (entry.kinds.get(key) ?? 0) + 1);
    byTag.set(r.tag, entry);
    if (r.kind === "BAD") bad += 1;
    if (r.kind === "typed-error" || (r.kind === "ok" && r.detail !== "open, no item yet")) {
      decodedTags.add(r.tag);
    }
    if (r.kind === "not-supported") missing.add(r.tag);
    else if (r.kind !== "BAD") implemented.add(r.tag);
  }
  console.log(`\n## ${scenario}: ${results.length} calls, ${byTag.size} methods`);
  for (const [tag, { stream, kinds }] of [...byTag].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const summary = [...kinds].map(([k, n]) => `${n}× ${k}`).join(", ");
    console.log(
      `${summary.includes("BAD") ? "FAIL" : "ok  "} ${tag}${stream ? " [stream]" : ""}: ${summary}`,
    );
  }
}
for (const tag of implemented) missing.delete(tag);
if (process.env.DECODE_COVERAGE) NodeFS.appendFileSync(process.env.DECODE_COVERAGE, [...decodedTags].map((t) => `${t}\n`).join(""));
console.log(`\nimplemented (${implemented.size}): ${[...implemented].sort().join(", ")}`);
console.log(`not supported (${missing.size}): ${[...missing].sort().join(", ")}`);
console.log(bad === 0 ? "\nevery answer is well formed" : `\n${bad} malformed answers`);
process.exitCode = bad === 0 ? 0 : 1;
