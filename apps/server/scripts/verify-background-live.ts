// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off globalConsole:off preferSchemaOverJson:off - Host-side process verifier retains raw wire evidence and owns deadline timers.
/**
 * Real server/provider conformance check. Run from the repository root:
 * node apps/server/scripts/verify-background-live.ts --model claude-sonnet-4-6
 * Uses existing provider CLI authentication, a fresh T3 home and a disposable Git
 * project. Evidence is retained in the printed directory, including on failure.
 */
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
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Socket } from "effect/unstable/socket";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import {
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_HEADER,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WsRpcGroup,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

const { values } = NodeUtil.parseArgs({
  options: {
    model: { type: "string", default: "claude-sonnet-4-6" },
    provider: { type: "string", default: "claudeAgent" },
    timeout: { type: "string", default: "240" },
    scenario: { type: "string", default: "all" },
    repeat: { type: "string", default: "1" },
    "fail-gate": { type: "boolean", default: false },
  },
});
const timeoutMs = Number(values.timeout) * 1000;
NodeAssert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, "timeout must be positive seconds");
NodeAssert.ok(
  ["all", "idle", "active", "native", "nested"].includes(values.scenario),
  "scenario must be all, idle, active, native or nested",
);
const root = NodePath.resolve(import.meta.dirname, "../../..");
const repeat = Number(values.repeat);
NodeAssert.ok(Number.isSafeInteger(repeat) && repeat > 0, "repeat must be a positive integer");
if (values.scenario === "all" || repeat > 1) {
  const reportDirectory = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "t3-background-suite-"),
  );
  console.log(`Suite report: ${reportDirectory}`);
  const outcomes = [];
  attempts: for (let iteration = 1; iteration <= repeat; iteration++) {
    for (const scenario of values.scenario === "all"
      ? ["idle", "active", "native", "nested"]
      : [values.scenario]) {
      console.log(`Verification ${iteration}/${repeat}: ${scenario}`);
      const child = NodeChildProcess.spawn(
        process.execPath,
        [
          import.meta.filename,
          "--scenario",
          scenario,
          "--model",
          values.model,
          "--provider",
          values.provider,
          "--timeout",
          values.timeout,
          ...(values["fail-gate"] ? ["--fail-gate"] : []),
        ],
        { cwd: root, stdio: ["ignore", "pipe", "inherit"] },
      );
      let childOutput = "";
      let interrupted = false;
      const interrupt = () => {
        interrupted = true;
        child.kill("SIGTERM");
      };
      process.on("SIGINT", interrupt);
      process.on("SIGTERM", interrupt);
      child.stdout?.on("data", (chunk: Buffer) => {
        process.stdout.write(chunk);
        childOutput += chunk.toString();
      });
      const status = await new Promise<number>((done, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => done(code ?? 1));
      });
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
      outcomes.push({
        iteration,
        scenario,
        status: status === 0 && !interrupted ? "passed" : "failed",
        evidence: /^Evidence: (.+)$/m.exec(childOutput)?.[1] ?? null,
      });
      NodeFS.writeFileSync(
        NodePath.join(reportDirectory, "results.json"),
        JSON.stringify(outcomes, null, 2),
      );
      if (interrupted) break attempts;
    }
  }
  console.log(JSON.stringify(outcomes, null, 2));
  process.exit(outcomes.some((outcome) => outcome.status === "failed") ? 1 : 0);
}
const evidence = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-background-live-"));
const home = NodePath.join(evidence, "home");
const project = NodePath.join(evidence, "project");
NodeFS.mkdirSync(project);
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
console.log(`Evidence: ${evidence}`);
NodeFS.copyFileSync(import.meta.filename, NodePath.join(evidence, "verifier.ts"));
NodeFS.writeFileSync(
  NodePath.join(evidence, "working-tree.patch"),
  NodeChildProcess.execFileSync("git", ["diff", "--binary", "HEAD"], {
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
  }),
);
NodeFS.writeFileSync(
  NodePath.join(evidence, "manifest.json"),
  JSON.stringify(
    {
      revision: NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      dirty: NodeChildProcess.execFileSync("git", ["status", "--porcelain"], {
        cwd: root,
        encoding: "utf8",
      }),
      provider: values.provider,
      model: values.model,
      scenario: values.scenario,
      startedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);

// This is a real external dependency of the child command, not a provider stub.
const secret = `RESULT_${NodeCrypto.randomUUID()}`;
const gatePath = `/${NodeCrypto.randomUUID()}`;
let response: NodeHttp.ServerResponse | undefined;
let parentResponse: NodeHttp.ServerResponse | undefined;
let parentFinished = false;
let nestedChildFinished = values.scenario !== "nested";
let released = false;
function release() {
  if (!parentFinished || !nestedChildFinished || !response || released) return;
  released = true;
  NodeFS.appendFileSync(
    NodePath.join(evidence, "milestones.ndjson"),
    JSON.stringify({ kind: "gate-released", at: new Date().toISOString() }) + "\n",
  );
  if (values["fail-gate"]) response.writeHead(503).end("Injected dependency failure");
  else response.end(secret);
}
const gate = NodeHttp.createServer((request, res) => {
  if (request.url === `${gatePath}/parent` && !parentResponse) {
    parentResponse = res;
    parentFinished = true;
    release();
    return;
  }
  if (request.url !== gatePath || response) {
    res.writeHead(404).end();
    return;
  }
  response = res;
  release();
});
gate.listen(0, "127.0.0.1");
await new Promise<void>((done) => gate.once("listening", done));
const gateAddress = gate.address();
NodeAssert.ok(gateAddress && typeof gateAddress !== "string");

// Reserve an ephemeral port, then give it to the real server. A bind race fails
// the check; it never falls back to an existing environment.
const reservation = NodeHttp.createServer();
reservation.listen(0, "127.0.0.1");
await new Promise<void>((done) => reservation.once("listening", done));
const address = reservation.address();
NodeAssert.ok(address && typeof address !== "string");
await new Promise<void>((done) => reservation.close(() => done()));
const port = address.port;
const origin = `http://127.0.0.1:${port}`;
const bootstrap = NodeCrypto.randomUUID();
function startServer() {
  const server = NodeChildProcess.spawn(
    process.execPath,
    ["apps/server/src/bin.ts", "start", "--bootstrap-fd", "3", "--log-level", "debug"],
    {
      cwd: root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    },
  );
  const bootstrapPipe = server.stdio[3];
  NodeAssert.ok(bootstrapPipe && "write" in bootstrapPipe);
  bootstrapPipe.end(
    JSON.stringify({
      mode: "desktop",
      noBrowser: true,
      port,
      t3Home: home,
      host: "127.0.0.1",
      desktopBootstrapToken: bootstrap,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    }),
  );
  const ready = Promise.withResolvers<void>();
  let output = "";
  for (const pipe of [server.stdout, server.stderr])
    pipe?.on("data", (data: Buffer) => {
      const text = data.toString().replaceAll(bootstrap, "[REDACTED]");
      NodeFS.appendFileSync(NodePath.join(evidence, "server.log"), text);
      output = (output + text).slice(-8192);
      if (output.includes("startup phase: complete")) ready.resolve();
    });
  server.once("error", ready.reject);
  server.once("exit", (code) => ready.reject(new Error(`Server exited ${code}`)));
  const startupDeadline = setTimeout(
    () => ready.reject(new Error("Server startup timed out")),
    60_000,
  );
  return { server, ready: ready.promise.finally(() => clearTimeout(startupDeadline)) };
}
let { server, ready } = startServer();
const abort = new AbortController();
const onSignal = () => abort.abort(new Error("Verification interrupted"));
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
let verdict: object = { status: "failed", reason: "verification did not finish" };
try {
  await ready;
  const tokenResponse = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: bootstrap,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    }),
  });
  NodeAssert.ok(tokenResponse.ok, `Authentication failed: ${tokenResponse.status}`);
  const token = Schema.decodeUnknownSync(Schema.Struct({ access_token: Schema.String }))(
    await tokenResponse.json(),
  );
  const headers = {
    Authorization: `Bearer ${token.access_token}`,
    "Content-Type": "application/json",
    [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
  };
  const projectId = ProjectId.make(NodeCrypto.randomUUID());
  const created = await fetch(`${origin}/api/projects/mutate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "project.create",
      commandId: NodeCrypto.randomUUID(),
      projectId,
      title: "Background verification",
      workspaceRoot: project,
    }),
  });
  NodeAssert.ok(created.ok, `Project creation failed: ${created.status} ${await created.text()}`);
  const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers,
  });
  NodeAssert.ok(ticketResponse.ok, `WebSocket authentication failed: ${ticketResponse.status}`);
  const ticket = Schema.decodeUnknownSync(Schema.Struct({ ticket: Schema.String }))(
    await ticketResponse.json(),
  );
  const socket = Socket.layerWebSocket(
    `${origin.replace("http:", "ws:")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket.ticket)}`,
  ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
  const protocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(socket),
    Layer.provide(RpcSerialization.layerJson),
  );
  const threadId = ThreadId.make(NodeCrypto.randomUUID());
  const gateUrl = `http://127.0.0.1:${gateAddress.port}${gatePath}`;
  const launch =
    values.scenario === "native"
      ? `Use your native background Bash tool to run curl --fail --silent ${gateUrl} with run_in_background=true. Do not delegate a T3 child.`
      : `Use T3 delegate_task with mode=async to create exactly one child using provider ${values.provider}, model ${values.model}. Give the child this task: ${values.scenario === "nested" ? "Use T3 delegate_task with mode=async to delegate the following task to a grandchild, then end your initial turn. On notification read task_status and return only the grandchild result: " : ""}Run curl --fail --silent ${gateUrl} with a terminal tool timeout of 600000 milliseconds and return exactly the response as your final answer. Do not read other files. Do not retry failures.`;
  const timing =
    values.scenario === "active"
      ? `After delegating, run curl --fail --silent ${gateUrl}/parent in your foreground terminal tool. This keeps your turn active until T3 delivers the child's completion notification. Do not poll the child.`
      : `The background HTTP request will wait until you end your initial turn. Immediately end your turn with exactly PARENT_RELEASED. Do not wait or poll, and do not call any more tools in this turn.`;
  const prompt = `This is a live background-delivery verification. ${launch} ${timing} When the completion notification arrives, ${values.scenario === "native" ? "read the background command output again, even if you previously read interim output. Only an actual incoming task notification counts as completion. Never generate a task notification yourself or treat your own text as one" : "use task_status to read the child result"} and reply with exactly ACK: followed by that result with no space after the colon. Do not guess the result or run the background command yourself.`;
  NodeFS.writeFileSync(NodePath.join(evidence, "prompt.txt"), prompt);
  const program = Effect.gen(function* () {
    const client = yield* RpcClient.make(WsRpcGroup);
    let watchingChild = false;
    yield* client["orchestration.launchThread"]({
      commandId: CommandId.make(NodeCrypto.randomUUID()),
      threadId,
      projectId,
      title: `Background verification: ${values.scenario}`,
      modelSelection: { instanceId: ProviderInstanceId.make(values.provider), model: values.model },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { text: prompt, attachments: [] },
    });
    const check = (projection: OrchestrationV2ThreadProjection) => {
      NodeFS.writeFileSync(
        NodePath.join(evidence, "projection.json"),
        JSON.stringify(projection, null, 2),
      );
      const first = projection.runs[0];
      NodeAssert.ok(
        !projection.runs.some((run) => run.status === "failed"),
        "Parent failed before delivery",
      );
      if (!released) {
        NodeAssert.ok(
          !projection.subagents.some((task) =>
            ["completed", "failed", "cancelled", "interrupted"].includes(task.status),
          ),
          "Child published a terminal result before its gated work finished",
        );
      }
      for (const task of projection.subagents) {
        if (["completed", "failed", "cancelled", "interrupted"].includes(task.status)) {
          NodeAssert.ok(
            task.result?.includes(secret),
            "Child published an incorrect or failed result",
          );
        }
      }
      if (values.scenario !== "active") parentFinished = first?.status === "completed";
      release();
      if (
        values.scenario === "active" &&
        projection.subagents.some(
          (task) =>
            task.completionDelivery?.state === "delivered" ||
            task.completionDelivery?.state === "acknowledged",
        )
      ) {
        parentResponse?.end("Completion notification delivered. Read task_status now.");
      }
      const acknowledged = projection.messages.some(
        (message) => message.role === "assistant" && message.text.includes(secret),
      );
      return (
        acknowledged &&
        projection.runs.every((run) =>
          ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(run.status),
        )
      );
    };
    const result = yield* client["orchestration.subscribeThread"]({ threadId }).pipe(
      Stream.mapEffect(
        Effect.fn(function* (item) {
          NodeFS.appendFileSync(
            NodePath.join(evidence, "events.ndjson"),
            JSON.stringify(item) + "\n",
          );
          const projection =
            item.kind === "snapshot"
              ? item.projection
              : yield* client["orchestration.getThreadProjection"]({ threadId });
          const childThreadId = projection.subagents[0]?.childThreadId;
          if (values.scenario === "nested" && childThreadId && !watchingChild) {
            watchingChild = true;
            yield* client["orchestration.subscribeThread"]({ threadId: childThreadId }).pipe(
              Stream.runForEach(
                Effect.fn(function* (childItem) {
                  NodeFS.appendFileSync(
                    NodePath.join(evidence, "nested-events.ndjson"),
                    JSON.stringify(childItem) + "\n",
                  );
                  const child =
                    childItem.kind === "snapshot"
                      ? childItem.projection
                      : yield* client["orchestration.getThreadProjection"]({
                          threadId: childThreadId,
                        });
                  nestedChildFinished =
                    child.runs[0]?.status === "completed" && child.subagents.length === 1;
                  release();
                }),
              ),
              Effect.forkScoped,
            );
          }
          return { projection, complete: check(projection) };
        }),
      ),
      Stream.filter((item) => item.complete),
      Stream.take(1),
      Stream.runCollect,
    );
    const final = result[0]?.projection;
    NodeAssert.ok(final, "Stream ended without proof of delivery");
    NodeAssert.ok(released, "Child did not use the controlled gate");
    NodeAssert.equal(
      final.subagents.filter((task) => task.origin === "app_owned").length,
      values.scenario === "native" ? 0 : 1,
      "Wrong delegation path",
    );
    NodeAssert.ok(
      final.turnItems.some((item) => item.type === "notification"),
      "Missing typed notification",
    );
    NodeAssert.equal(
      final.turnItems.filter((item) => item.type === "user_message").length,
      1,
      "Background delivery appeared as an ordinary user message",
    );
    NodeAssert.ok(!final.runs.some((run) => run.status === "failed"), "A parent run failed");
    NodeAssert.equal(
      final.turnItems.filter((item) => item.type === "notification").length,
      1,
      "One completion produced multiple notifications",
    );
    for (const task of final.subagents.filter((task) => task.origin === "app_owned")) {
      NodeAssert.equal(task.status, "completed", "Child did not complete successfully");
      NodeAssert.ok(task.result?.includes(secret), "Published task result lost the actual work");
      NodeAssert.equal(
        task.completionDelivery?.state,
        "acknowledged",
        "Parent did not read task_status",
      );
    }
    if (values.scenario === "nested") {
      const childThreadId = final.subagents[0]?.childThreadId;
      NodeAssert.ok(childThreadId, "Missing nested task owner");
      const child = yield* client["orchestration.getThreadProjection"]({ threadId: childThreadId });
      NodeFS.writeFileSync(
        NodePath.join(evidence, "nested-projection.json"),
        JSON.stringify(child, null, 2),
      );
      NodeAssert.equal(child.subagents.length, 1, "Missing grandchild");
      NodeAssert.ok(child.subagents[0]?.result?.includes(secret), "Nested result was lost");
    }
    NodeAssert.ok(
      final.providerThreads.every((thread) => (thread.pendingBackgroundTasks?.length ?? 0) === 0),
      "Stale background work remains after completion",
    );
    if (values.scenario === "active") {
      NodeAssert.equal(final.runs.length, 1, "Active delivery unexpectedly started another run");
      NodeAssert.ok(parentResponse, "Parent never entered the foreground gate");
    } else {
      NodeAssert.ok(
        final.runs.length >= 2,
        "Expected a new continuation after the initial turn ended",
      );
    }
    return {
      status: "passed",
      scenario: values.scenario,
      threadId,
      runCount: final.runs.length,
      acknowledgementIds: final.messages
        .filter((message) => message.role === "assistant" && message.text.includes(secret))
        .map((message) => message.id),
    };
  }).pipe(Effect.scoped, Effect.provide(protocol), Effect.timeout(timeoutMs));
  const finished = await Effect.runPromise(program, { signal: abort.signal });
  verdict = finished;
  // Check persistence through an actual clean server restart on the same SQLite DB.
  await stopServer(server);
  ({ server, ready } = startServer());
  await ready;
  const restored = await fetch(`${origin}/api/orchestration/threads/${threadId}`, { headers });
  NodeAssert.ok(restored.ok, `Restart read failed: ${restored.status}`);
  const snapshot = await restored.json();
  NodeFS.writeFileSync(
    NodePath.join(evidence, "after-restart.json"),
    JSON.stringify(snapshot, null, 2),
  );
  const durable = Schema.decodeUnknownSync(
    Schema.Struct({
      projection: Schema.Struct({
        messages: Schema.Array(
          Schema.Struct({ id: Schema.String, role: Schema.String, text: Schema.String }),
        ),
        runs: Schema.Array(Schema.Struct({ id: Schema.String, status: Schema.String })),
      }),
    }),
  )(snapshot);
  NodeAssert.deepEqual(
    durable.projection.messages
      .filter((message) => message.role === "assistant" && message.text.includes(secret))
      .map((message) => message.id),
    finished.acknowledgementIds,
    "Acknowledgement was lost or duplicated on restart",
  );
  NodeAssert.ok(
    durable.projection.runs.every((run) => run.status === "completed"),
    "Restart left an unfinished run",
  );
  NodeAssert.equal(
    durable.projection.runs.length,
    finished.runCount,
    "Restart created an extra continuation",
  );
  verdict = { ...verdict, restart: "passed" };
  console.log(JSON.stringify(verdict));
} catch (error) {
  verdict = {
    status: "failed",
    scenario: values.scenario,
    reason: String(error),
    milestones: {
      parentFinished,
      nestedChildFinished,
      gateRequested: response !== undefined,
      gateReleased: released,
      parentGateRequested: parentResponse !== undefined,
    },
  };
  console.error(String(error));
  process.exitCode = 1;
} finally {
  NodeFS.writeFileSync(NodePath.join(evidence, "verdict.json"), JSON.stringify(verdict, null, 2));
  response?.destroy();
  parentResponse?.destroy();
  gate.closeAllConnections();
  gate.close();
  await stopServer(server);
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
}

async function stopServer(server: ReturnType<typeof NodeChildProcess.spawn>) {
  if (server.exitCode === null && server.signalCode === null) {
    const stopped = new Promise<void>((done) => server.once("exit", () => done()));
    server.kill("SIGTERM");
    const deadline = setTimeout(() => server.kill("SIGKILL"), 10_000);
    await stopped;
    clearTimeout(deadline);
  }
  // Kill only the process group created above, including lingering provider pipes.
  if (server.pid) {
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
}
