// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off globalConsole:off preferSchemaOverJson:off - Host-side verifier records real transport evidence and owns deadlines.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";

import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Socket } from "effect/socket";
import { RpcClient, RpcSerialization } from "effect/rpc";
import {
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_HEADER,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WsRpcGroup,
} from "@t3tools/contracts";

const { values } = NodeUtil.parseArgs({
  options: {
    root: { type: "string", default: NodePath.resolve(import.meta.dirname, "../../..") },
    output: { type: "string" },
    revision: { type: "string", default: "after" },
    rows: { type: "string", default: "R1,R2,R3,R4,R5,R6" },
  },
});
const root = NodePath.resolve(values.root);
const evidence =
  values.output ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-acp-busy-"));
NodeFS.mkdirSync(evidence, { recursive: true });
const home = NodePath.join(evidence, "home");
const project = NodePath.join(evidence, "project");
NodeFS.mkdirSync(project, { recursive: true });
NodeChildProcess.execFileSync("git", ["init", "-q", project]);
NodeChildProcess.execFileSync("git", [
  "-C",
  project,
  "-c",
  "user.name=Verifier",
  "-c",
  "user.email=verifier@localhost",
  "commit",
  "--allow-empty",
  "-qm",
  "initial",
]);
const fixture = NodePath.join(import.meta.dirname, "fixtures/acp-busy/agent.mjs");
const git = (...args) =>
  NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const manifest = {
  revision: git("rev-parse", "HEAD"),
  dirty: git("status", "--porcelain"),
  root,
  home,
  invocation: process.argv,
  node: process.version,
  os: `${NodeOS.type()} ${NodeOS.release()} ${NodeOS.machine()}`,
  fixture: NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(fixture)).digest("hex"),
  driver: NodeCrypto.createHash("sha256")
    .update(NodeFS.readFileSync(import.meta.filename))
    .digest("hex"),
  synthetic: "ACP v1 t3-synthetic-busy-lifecycle; not oh-my-pi",
  startedAt: new Date().toISOString(),
};
const log = (kind, data) =>
  NodeFS.appendFileSync(
    NodePath.join(evidence, "transcript.ndjson"),
    JSON.stringify({
      at: new Date().toISOString(),
      mono: process.hrtime.bigint().toString(),
      kind,
      ...data,
    }) + "\n",
  );
const reservation = NodeHttp.createServer();
reservation.listen(0, "127.0.0.1");
await new Promise((done) => reservation.once("listening", done));
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const origin = `http://127.0.0.1:${port}`;
const bootstrap = NodeCrypto.randomUUID();
const command = [
  "apps/server/src/bin.ts",
  "start",
  "--base-dir",
  home,
  "--port",
  String(port),
  "--host",
  "127.0.0.1",
  "--no-browser",
  "--bootstrap-fd",
  "3",
  "--log-level",
  "debug",
];
const server = NodeChildProcess.spawn(process.execPath, command, {
  cwd: root,
  detached: true,
  stdio: ["ignore", "pipe", "pipe", "pipe"],
});
manifest.launch = {
  command: [process.execPath, ...command],
  origin,
  pid: server.pid,
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port,
    t3Home: home,
    host: "127.0.0.1",
    desktopBootstrapToken: "[REDACTED]",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
};
server.stdio[3].end(
  JSON.stringify({ ...manifest.launch.bootstrap, desktopBootstrapToken: bootstrap }),
);
NodeFS.writeFileSync(NodePath.join(evidence, "manifest.json"), JSON.stringify(manifest, null, 2));
NodeFS.copyFileSync(fixture, NodePath.join(evidence, "fixture.mjs"));
NodeFS.copyFileSync(import.meta.filename, NodePath.join(evidence, "driver.mjs"));
const ready = Promise.withResolvers();
let output = "";
for (const pipe of [server.stdout, server.stderr])
  pipe.on("data", (data) => {
    const text = data
      .toString()
      .replaceAll(bootstrap, "[REDACTED]")
      .replace(/(pairingUrl:|Pairing URL:).*$/gim, "$1 [REDACTED]");
    NodeFS.appendFileSync(NodePath.join(evidence, "server.log"), text);
    output = (output + text).slice(-16384);
    if (output.includes("startup phase: complete")) ready.resolve();
  });
server.once("exit", (code) => ready.reject(new Error(`Server exited ${code}`)));
const startupTimer = setTimeout(() => ready.reject(new Error("Startup deadline")), 60000);
const abort = new AbortController();
const onSignal = () => abort.abort(new Error("Interrupted"));
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
const outcomes = [];
try {
  await ready.promise.finally(() => clearTimeout(startupTimer));
  const tokenResponse = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: bootstrap,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    }),
  });
  NodeAssert.ok(tokenResponse.ok, `Authentication ${tokenResponse.status}`);
  const { access_token } = await tokenResponse.json();
  const headers = {
    Authorization: `Bearer ${access_token}`,
    "Content-Type": "application/json",
    [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
  };
  log("authenticated", {
    origin,
    status: tokenResponse.status,
    transport: "existing desktop bootstrap OAuth exchange + WebSocket ticket; credentials omitted",
  });
  const projectId = ProjectId.make(NodeCrypto.randomUUID());
  const created = await fetch(`${origin}/api/projects/mutate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "project.create",
      commandId: NodeCrypto.randomUUID(),
      projectId,
      title: "Synthetic ACP busy lifecycle",
      workspaceRoot: project,
    }),
  });
  const receipt = await created.text();
  log("project-receipt", { status: created.status, receipt });
  NodeAssert.ok(created.ok);
  const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers,
  });
  NodeAssert.ok(ticketResponse.ok);
  const ticket = await ticketResponse.json();
  const layerSocket = Socket.layerWebSocket(
    `${origin.replace("http:", "ws:")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket.ticket)}`,
  ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
  const layerProtocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(layerSocket),
    Layer.provide(RpcSerialization.layerJson),
  );
  const modes = {
    R1: "recovery",
    R2: "long-busy",
    R3: "queued-stop",
    R4: "in-flight-stop",
    R5: "old-output",
    R6: "unrelated-error",
  };
  const program = Effect.gen(function* () {
    const client = yield* RpcClient.make(WsRpcGroup);
    for (const row of values.rows.split(",")) {
      const mode = modes[row];
      NodeAssert.ok(mode, row);
      const directory = NodePath.join(evidence, row);
      NodeFS.mkdirSync(directory, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(directory, "wire.ndjson"), "");
      const instanceId = ProviderInstanceId.make(`synthetic${row}`);
      const config = {
        driver: "acpRegistry",
        displayName: `Synthetic ACP v1 ${row}`,
        config: {
          source: "local",
          commandPath: process.execPath,
          commandArgs: [fixture, mode, directory],
          customModels: ["synthetic-busy"],
        },
      };
      log("provider-config", { row, instanceId, config });
      yield* client["server.updateSettings"]({
        patch: {},
        providerInstanceMutation: { operation: "create", instanceId, instance: config },
      });
      const threadId = ThreadId.make(NodeCrypto.randomUUID());
      const snapshot = Effect.fn("BusyVerifier.snapshot")(function* (label) {
        const projection = yield* client["orchestration.getThreadProjection"]({ threadId });
        log("projection", { row, label, projection });
        return projection;
      });
      const wait = (label, predicate) =>
        client["orchestration.subscribeThread"]({ threadId }).pipe(
          Stream.mapEffect(
            Effect.fn("BusyVerifier.observe")(function* (event) {
              log("persisted-thread-event", { row, label, event });
              const projection =
                event.kind === "snapshot"
                  ? event.projection
                  : yield* client["orchestration.getThreadProjection"]({ threadId });
              log("projection", { row, label, projection });
              return projection;
            }),
          ),
          Stream.filter(predicate),
          Stream.take(1),
          Stream.runCollect,
          Effect.map((items) => {
            NodeAssert.ok(items[0], label);
            return items[0];
          }),
          Effect.timeout(row === "R2" ? "6 minutes" : "45 seconds"),
        );
      const dispatch = Effect.fn("BusyVerifier.dispatch")(function* (text) {
        const command = {
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(NodeCrypto.randomUUID()),
          threadId,
          messageId: NodeCrypto.randomUUID(),
          text,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
        };
        log("command", { row, command });
        const receipt = yield* client["orchestration.dispatchCommand"](command);
        log("command-receipt", { row, receipt });
        return receipt;
      });
      const launch = {
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        threadId,
        projectId,
        title: `Synthetic ACP ${row}`,
        modelSelection: { instanceId, model: "synthetic-busy" },
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        generateTitle: false,
        initialMessage: { text: "Begin synthetic busy lifecycle.", attachments: [] },
      };
      log("launch", { row, launch });
      const launched = yield* client["orchestration.launchThread"](launch);
      log("launch-receipt", { row, launched });
      const first = yield* wait(
        "first-completed",
        (p) => p.runs.length > 0 && p.runs.every((r) => r.status === "completed"),
      );
      NodeAssert.ok(
        first.messages.some((m) => m.role === "assistant" && m.text.includes("Press the key")),
      );
      yield* dispatch("нажал");
      const wire = () =>
        NodeFS.readFileSync(NodePath.join(directory, "wire.ndjson"), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((s) => JSON.parse(s));
      const prompts = () =>
        wire().filter(
          (e) => e.direction === "server-to-agent" && e.frame.method === "session/prompt",
        );
      const retryItems = (p) =>
        p.turnItems.filter((i) => i.type === "error" && i.retry !== undefined);
      const queued = (p) => retryItems(p).some((i) => i.status === "running");
      const terminal = (p) =>
        p.runs.length >= 2 &&
        p.runs.every((r) => ["completed", "failed", "interrupted"].includes(r.status));
      const after = values.revision === "after";
      if (!after || row === "R6") {
        const final = yield* wait(
          "followup-failed",
          (p) => terminal(p) && p.runs.some((r) => r.status === "failed"),
        );
        if (row === "R5") {
          NodeFS.writeFileSync(NodePath.join(directory, "old"), "emit");
          yield* Effect.promise(() =>
            waitWire(directory, (frames) =>
              frames.some(
                (e) =>
                  e.frame.method === "session/update" &&
                  e.frame.params.update.sessionUpdate === "agent_thought_chunk",
              ),
            ),
          );
        }
        yield* Effect.promise(() => observe(2200));
        if (row === "R5") yield* snapshot("baseline-after-late-output");
        NodeAssert.equal(prompts().length, 2);
        NodeAssert.equal(retryItems(final).length, 0);
        if (row === "R3" || row === "R4") {
          const command = {
            type: "thread.stop",
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            threadId,
          };
          const result = yield* Effect.exit(client["orchestration.dispatchCommand"](command));
          log("baseline-stop-actual", { row, command, result });
        }
      } else {
        const initial = yield* wait("busy-queued", queued);
        NodeAssert.ok(!terminal(initial));
        NodeAssert.deepEqual(retryItems(initial).at(-1).retry, {
          attempt: 1,
          maxAttempts: null,
          retryDelayMs: 1000,
        });
        if (row === "R3" || row === "R4") {
          if (row === "R4")
            yield* Effect.promise(() =>
              waitWire(
                directory,
                (frames) =>
                  frames.filter(
                    (e) => e.direction === "server-to-agent" && e.frame.method === "session/prompt",
                  ).length >= 3,
              ),
            );
          const command = {
            type: "thread.stop",
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            threadId,
          };
          log("command", { row, command });
          const receipt = yield* client["orchestration.dispatchCommand"](command);
          log("command-receipt", { row, receipt });
          const stopped = yield* wait(
            "stopped",
            (p) => terminal(p) && p.runs.some((r) => r.status === "interrupted"),
          );
          NodeAssert.ok(!stopped.runs.some((r) => r.status === "failed"));
          const count = prompts().length;
          NodeAssert.equal(count, row === "R3" ? 2 : 3);
          yield* Effect.promise(() =>
            waitWire(directory, (frames) =>
              frames.some((e) => e.frame.method === "session/cancel"),
            ),
          );
          log("absence-window-start", { row, count, milliseconds: 60000 });
          yield* Effect.promise(() => observe(60000));
          NodeAssert.equal(prompts().length, count);
          log("absence-window-end", { row, count: prompts().length });
          yield* snapshot("after-absence-window");
          yield* dispatch("FRESH independent prompt");
          const fresh = yield* wait(
            "fresh-completed",
            (p) =>
              p.runs.length >= 3 &&
              p.runs.every((r) => ["completed", "interrupted"].includes(r.status)) &&
              p.messages.some(
                (m) => m.role === "assistant" && m.text.includes("Fresh turn works."),
              ),
          );
          NodeAssert.ok(!fresh.runs.some((r) => r.status === "failed"));
          NodeAssert.ok(!queued(fresh));
          NodeAssert.equal(retryItems(fresh).at(-1)?.status, "interrupted");
          if (row === "R4") {
            const frames = wire();
            const cancelIndex = frames.findIndex((e) => e.frame.method === "session/cancel");
            const heldId = prompts()[2].frame.id;
            const responseIndex = frames.findIndex(
              (e) => e.direction === "agent-to-server" && e.frame.id === heldId,
            );
            NodeAssert.ok(
              cancelIndex >= 0 && responseIndex > cancelIndex,
              "Stop must precede held busy response",
            );
          }
        } else {
          if (row === "R5") {
            yield* Effect.promise(() =>
              waitWire(
                directory,
                (frames) =>
                  frames.filter(
                    (e) => e.direction === "server-to-agent" && e.frame.method === "session/prompt",
                  ).length >= 3,
              ),
            );
            NodeFS.writeFileSync(NodePath.join(directory, "old"), "emit");
            const old = yield* wait("old-output-while-queued", (p) =>
              p.nodes.some((node) => node.kind === "reasoning" && node.runId === p.runs.at(-1).id),
            );
            const reasoningNode = old.nodes.find(
              (node) => node.kind === "reasoning" && node.runId === old.runs.at(-1).id,
            );
            const detail = yield* client["orchestration.getTurnItem"]({
              threadId,
              itemId: reasoningNode.id.replace(/^node:/, "turn-item:"),
            });
            log("old-output-detail", { row, detail });
            // Streaming reasoning is represented by a durable node before its final item is stored.
            NodeAssert.ok(queued(old));
            NodeAssert.ok(!terminal(old));
          }
          NodeFS.writeFileSync(NodePath.join(directory, "release"), "accept");
          const final = yield* wait(
            "recovered",
            (p) => terminal(p) && p.runs.every((r) => r.status === "completed"),
          );
          NodeAssert.ok(
            final.messages.some(
              (m) => m.role === "assistant" && m.text.includes("Received your confirmation."),
            ),
          );
          NodeAssert.ok(!queued(final));
          if (row === "R5") {
            const node = final.nodes.find((node) => node.kind === "reasoning");
            const detail = yield* client["orchestration.getTurnItem"]({
              threadId,
              itemId: node.id.replace(/^node:/, "turn-item:"),
            });
            log("old-output-final-detail", { row, detail });
            NodeAssert.equal(detail.item?.text, "Previous background work is still running.");
          }
          const confirmations = prompts().slice(1);
          NodeAssert.equal(confirmations.length, row === "R2" ? 13 : 2);
          for (const prompt of confirmations)
            NodeAssert.deepEqual(prompt.frame.params, confirmations[0].frame.params);
          if (row === "R1") {
            yield* dispatch("FRESH independent prompt");
            yield* wait(
              "fresh-completed",
              (p) =>
                p.runs.length === 3 &&
                p.runs.every((r) => r.status === "completed") &&
                p.messages.some(
                  (m) => m.role === "assistant" && m.text.includes("Fresh turn works."),
                ),
            );
          }
          if (row === "R2") {
            const elapsed =
              Number(BigInt(confirmations.at(-1).mono) - BigInt(confirmations[0].mono)) / 1e9;
            NodeAssert.ok(elapsed >= 241, `Real busy interval ${elapsed}`);
            log("long-busy-elapsed", { row, elapsed });
          }
        }
      }
      const final = yield* snapshot("final");
      const confirmationFrames = prompts().filter((e) =>
        e.frame.params.prompt.some((part) => part.type === "text" && part.text === "нажал"),
      );
      for (const frame of confirmationFrames)
        NodeAssert.deepEqual(frame.frame.params, confirmationFrames[0].frame.params);
      if (row === "R6")
        NodeAssert.ok(
          final.turnItems.some(
            (i) => i.type === "error" && i.failure.message === "Another internal error",
          ),
        );
      const outcome = {
        row,
        mode,
        revision: manifest.revision,
        status: "passed",
        dispatches: prompts().length,
        threadId,
        runs: final.runs.map((r) => ({ id: r.id, status: r.status })),
        retryItems: retryItems(final),
      };
      outcomes.push(outcome);
      log("row-result", outcome);
      console.log(JSON.stringify(outcome));
      NodeFS.writeFileSync(
        NodePath.join(evidence, "results.json"),
        JSON.stringify(outcomes, null, 2),
      );
    }
  });
  await Effect.runPromise(program.pipe(Effect.provide(layerProtocol), Effect.scoped), {
    signal: abort.signal,
  });
} catch (error) {
  log("failure", { error: String(error), stack: error.stack });
  console.error(NodeUtil.inspect(error, { depth: 12 }));
  process.exitCode = 1;
} finally {
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  if (server.pid) {
    const stopped =
      server.exitCode === null && server.signalCode === null
        ? new Promise((done) => server.once("exit", done))
        : Promise.resolve();
    stopGroup(server.pid, "SIGTERM");
    const timer = setTimeout(() => {
      try {
        process.kill(-server.pid, "SIGKILL");
      } catch {}
    }, 10000);
    await stopped;
    clearTimeout(timer);
    stopGroup(server.pid, "SIGKILL");
    log("cleanup", { ownedServerPid: server.pid, groupStopped: true });
  }
}
function observe(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function waitWire(directory, predicate) {
  return new Promise((resolve, reject) => {
    const path = NodePath.join(directory, "wire.ndjson");
    const watcher = NodeFS.watch(path, check);
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error("Wire milestone deadline"));
    }, 45000);
    function check() {
      const frames = NodeFS.readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((s) => JSON.parse(s));
      if (predicate(frames)) {
        watcher.close();
        clearTimeout(timer);
        resolve();
      }
    }
    check();
  });
}

function stopGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
