#!/usr/bin/env node
// Provider sign-in (`provider.auth.*`) on the T3 server and the Conn Server, call by call.
//
//   node crates/conn-server/tools/provider-auth-diff.mjs [--keep] <conn-server>
//
// The T3 server has no in-app sign-in for Claude, Codex (`setupMode` other than `managed`)
// or Grok: those instances carry no `ProviderAuthController`, so `ProviderAuthService` answers
// every sign-in method with a `ProviderSetupError` and starts no CLI. This check holds the
// Conn Server to the same, and fails when upstream adds a sign-in flow for one of them.
//
// Each server starts on its own temp state (T3: a temp T3CODE_HOME and a free port; Conn: a
// temp `--state-dir`). `claude`, `codex` and `grok` on PATH are recording stubs: each run
// appends its argv, its environment names and its stdin to a log, then exits 1. The real
// CLIs can never be found. The tool pairs with the client's own functions, opens the RPC
// socket with Effect's RpcClient and the contract's `WsRpcGroup`, and for the instances
// `claudeAgent`, `codex`, `grok` and an unknown one calls `provider.auth.start`, `respond`,
// `complete`, `cancel`, `removeMethod`, `logout` and the first `provider.auth.subscribe` event.
// It compares:
// - each reply (the decoded value, or the typed error), which must be equal;
// - the stub runs between the first and the last call (after the start-up probes are quiet),
//   with the side's folder replaced, which must be equal. The start-up probes must have run
//   a stub on both sides, so a CLI start is seen.
// No model is called. Every process gets a sealed environment and is stopped by PID.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { importSource, monorepo, packageImporter } from "../../../tools/monorepo.mjs";
import { sealedEnv, sealedNodeEnv } from "../../../tools/sealed-env.mjs";
import { GUARD_ARG } from "../../../tools/no-outside-fetch.mjs";

const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const binaryArg = argv.find((a) => !a.startsWith("--"));
if (binaryArg === undefined) {
  console.error("usage: provider-auth-diff.mjs [--keep] <conn-server>");
  process.exit(2);
}
const rustBinary = NodePath.resolve(binaryArg);
const MONOREPO = monorepo();

const load = packageImporter("packages/contracts");
const Effect = await load("effect/Effect");
const Exit = await load("effect/Exit");
const Layer = await load("effect/Layer");
const Option = await load("effect/Option");
const Redacted = await load("effect/Redacted");
const Stream = await load("effect/Stream");
const { FetchHttpClient } = await load("effect/http");
const { RpcClient, RpcSerialization } = await load("effect/rpc");
const Socket = await load("effect/socket/Socket");
const { WsRpcGroup } = await importSource("packages/contracts/src/rpc.ts");
const { joinSocketFrameParts } = await importSource("packages/shared/src/socketFrameParts.ts");
const { appendOrchestrationProtocol } = await importSource(
  "packages/client-runtime/src/connection/compatibility.ts",
);
const { bootstrapRemoteBearerSession, issueRemoteWebSocketTicket } = await importSource(
  "packages/client-runtime/src/authorization/remote.ts",
);

const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-auth-diff-")));
const servers = new Set();
process.once("exit", () => {
  for (const child of servers) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  }
  if (!keep) NodeFS.rmSync(root, { recursive: true, force: true });
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => process.exit(130));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () =>
  new Promise((resolve) => {
    const probe = NodeNet.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

let failed = false;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` -> ${detail}` : ""}`);
  if (!ok) failed = true;
};

/** A recording stub: argv, environment names and up to 200 ms of stdin, then exit 1. */
function writeStub(bin, name, log) {
  const script = NodePath.join(bin, `${name}.mjs`);
  NodeFS.writeFileSync(
    script,
    `import * as fs from "node:fs";
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("error", () => {});
setTimeout(() => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
    name: ${JSON.stringify(name)},
    argv: process.argv.slice(2),
    env: Object.keys(process.env).sort(),
    stdin: Buffer.concat(chunks).toString("utf8"),
  }) + "\\n");
  process.exit(1);
}, 200);
`,
  );
  NodeFS.writeFileSync(
    NodePath.join(bin, name),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`,
    { mode: 0o755 },
  );
}

class Side {
  constructor(kind) {
    this.kind = kind;
    this.name = kind === "ts" ? "T3" : "Conn";
    this.dir = NodePath.join(root, kind);
    NodeFS.mkdirSync(this.dir, { recursive: true });
    this.out = NodePath.join(this.dir, "server.out");
    this.log = NodePath.join(this.dir, "stub-runs.ndjson");
    NodeFS.writeFileSync(this.log, "");
    const bin = NodePath.join(this.dir, "stubs");
    NodeFS.mkdirSync(bin);
    for (const name of ["claude", "codex", "grok"]) writeStub(bin, name, this.log);
    const base = sealedEnv(this.dir);
    // The stubs come first; the rest of the sealed PATH holds no provider CLI.
    this.path = `${bin}:${base.PATH}`;
    if (kind === "ts") {
      // No provider update check (registry.npmjs.org).
      const userdata = NodePath.join(this.dir, "base", "userdata");
      NodeFS.mkdirSync(userdata, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(userdata, "settings.json"), JSON.stringify({ enableProviderUpdateChecks: false }));
    }
  }

  env() {
    if (this.kind === "ts") {
      // No telemetry to ingest.t3.codes (AnalyticsService.ts reads T3CODE_TELEMETRY_ENABLED).
      return {
        ...sealedNodeEnv(this.dir),
        PATH: this.path,
        T3CODE_HOME: NodePath.join(this.dir, "base"),
        T3CODE_NO_BROWSER: "1",
        T3CODE_TELEMETRY_ENABLED: "false",
      };
    }
    // The status probes run on the stubs, as T3's do, so a run is seen to be recorded.
    return { ...sealedEnv(this.dir), PATH: this.path, CONN_CLAUDE_STATUS_PROBE: "on", CONN_CODEX_STATUS_PROBE: "on" };
  }

  command(port) {
    if (this.kind === "ts") {
      return [
        process.execPath,
        [GUARD_ARG, NodePath.join(MONOREPO, "apps/server/src/bin.ts"), "serve", "--no-browser", "--port", String(port), "--host", "127.0.0.1", "--base-dir", NodePath.join(this.dir, "base")],
      ];
    }
    return [rustBinary, ["serve", "--listen", `127.0.0.1:${port}`, "--state-dir", NodePath.join(this.dir, "state")]];
  }

  async start() {
    const port = await freePort();
    this.origin = `http://127.0.0.1:${port}`;
    const [command, args] = this.command(port);
    const out = NodeFS.openSync(this.out, "a");
    const child = NodeChildProcess.spawn(command, args, { cwd: this.dir, env: this.env(), detached: true, stdio: ["ignore", out, out] });
    NodeFS.closeSync(out);
    servers.add(child);
    this.child = child;
    for (const deadline = Date.now() + 90_000; Date.now() < deadline; await sleep(100)) {
      if (child.exitCode !== null) throw new Error(`${this.name} server exited ${child.exitCode}; see ${this.out}`);
      const code = NodeFS.readFileSync(this.out, "utf8").match(/pair#token=([A-Za-z0-9]+)/)?.[1];
      if (code === undefined) continue;
      try {
        const response = await fetch(`${this.origin}/.well-known/t3/environment`);
        if (response.ok) return code;
      } catch {}
    }
    throw new Error(`${this.name} server did not start in 90 s; see ${this.out}`);
  }

  /** Stub runs so far, the side's folder replaced. */
  runs() {
    return NodeFS.readFileSync(this.log, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line.replaceAll(this.dir, "<dir>")));
  }

  /** Waits until no stub has run for 3 s (the start-up probes), at most 60 s. */
  async quiet() {
    let count = -1;
    let since = Date.now();
    for (const deadline = Date.now() + 60_000; Date.now() < deadline; await sleep(250)) {
      const now = this.runs().length;
      if (now !== count) {
        count = now;
        since = Date.now();
      } else if (Date.now() - since >= 3_000) return;
    }
  }

  async stop() {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    process.kill(child.pid, "SIGTERM");
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, 15_000);
    await exited;
    clearTimeout(timer);
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
}

const INSTANCES = ["claudeAgent", "codex", "grok", "no-such-instance"];
const CALLS = [
  ["provider.auth.start", {}],
  ["provider.auth.start", { methodId: "chatgpt", returnUrl: "http://localhost/settings", callbackMode: "client" }],
  ["provider.auth.respond", { flowId: "flow-1", interactionId: "i-1", response: { type: "browser", action: "accept" } }],
  ["provider.auth.respond", { flowId: "flow-1", interactionId: "i-1", response: { type: "terminal", data: "y\r" } }],
  ["provider.auth.complete", { flowId: "flow-1", callbackUrl: "http://localhost:1455/auth/callback?code=x&state=y" }],
  ["provider.auth.cancel", { flowId: "flow-1" }],
  ["provider.auth.removeMethod", { methodId: "chatgpt" }],
  ["provider.auth.logout", {}],
  ["provider.auth.subscribe", {}],
];

/** The reply as the client decodes it: a value, the first stream item, or the typed error. */
function reply(exit, stream) {
  if (Exit.isSuccess(exit)) {
    if (!stream) return { value: exit.value };
    return Option.isNone(exit.value) ? { stream: "open, no item in 2 s" } : { first: exit.value.value };
  }
  const fail = exit.cause.reasons.find((r) => r._tag === "Fail");
  if (fail) return { error: JSON.parse(JSON.stringify(fail.error)) };
  return { defect: String(exit.cause).split("\n")[0] };
}

async function drive(side) {
  const code = await side.start();
  await side.quiet();
  const pairing = Effect.gen(function* () {
    const access = yield* bootstrapRemoteBearerSession({ httpBaseUrl: side.origin, credential: code });
    const ticket = yield* issueRemoteWebSocketTicket({ httpBaseUrl: side.origin, bearerToken: access.access_token, use: "rpc" });
    return Redacted.value(ticket.ticket);
  }).pipe(Effect.provide(FetchHttpClient.layer));
  const ticket = await Effect.runPromise(pairing);
  const socketUrl = new URL(appendOrchestrationProtocol(`${side.origin.replace(/^http/, "ws")}/ws`));
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
  const before = side.runs().length;
  check(`${side.name}: the start-up probes ran the stubs`, before > 0, `${before} runs`);
  const program = Effect.gen(function* () {
    const client = yield* RpcClient.make(WsRpcGroup);
    const replies = [];
    for (const instanceId of INSTANCES) {
      for (const [tag, input] of CALLS) {
        const stream = tag === "provider.auth.subscribe";
        const payload = { instanceId, ...input };
        const exit = stream
          ? yield* Effect.exit(Stream.runHead(client[tag](payload)).pipe(Effect.timeoutOption("2 seconds")))
          : yield* Effect.exit(client[tag](payload).pipe(Effect.timeout("15 seconds")));
        replies.push({ call: `${tag} ${JSON.stringify(payload)}`, reply: reply(exit, stream) });
      }
    }
    return replies;
  }).pipe(Effect.scoped, Effect.provide(protocol), Effect.timeout("120 seconds"));
  const replies = await Effect.runPromise(program);
  // A CLI started by a sign-in call has had time to run and record.
  await sleep(1_500);
  const runs = side.runs().slice(before);
  await side.stop();
  return { replies, runs };
}

try {
  const ts = new Side("ts");
  const conn = new Side("conn");
  const [t3, ours] = await Promise.all([drive(ts), drive(conn)]);
  for (let i = 0; i < t3.replies.length; i += 1) {
    const a = t3.replies[i];
    const b = ours.replies[i];
    const same = JSON.stringify(a.reply) === JSON.stringify(b?.reply);
    check(a.call, same, same ? JSON.stringify(a.reply) : `T3 ${JSON.stringify(a.reply)} | Conn ${JSON.stringify(b?.reply)}`);
  }
  check(
    "CLI runs during the sign-in calls",
    JSON.stringify(t3.runs) === JSON.stringify(ours.runs),
    `T3 ${JSON.stringify(t3.runs)} | Conn ${JSON.stringify(ours.runs)}`,
  );
} catch (error) {
  check("run", false, error?.stack ?? String(error));
}
process.exit(failed ? 1 : 0);
