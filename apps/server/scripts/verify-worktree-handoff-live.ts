// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalDateInEffect:off globalFetch:off globalConsole:off preferSchemaOverJson:off - Host-side live verifier retains raw wire evidence and owns deadline timers.
//
// Live evidence driver for t3_worktree_handoff on exclusive (Claude) sessions (issue #15136).
// Real agent turns call the T3 MCP tools; this script only launches threads, records every
// subscription item for the parent and child threads, and dispatches run.interrupt or
// queued-run.cancel for R2.
//
// Rows:
//   r1  Claude parent delegates an async Claude child; the child calls t3_worktree_status, then
//       t3_worktree_handoff with a short continuation as its last action.
//   r2  r1 with a long continuation; the driver interrupts the child's continuation once it runs,
//       or cancels it when it is stuck in a held queue.
//   r3  A Claude top-level thread hands itself off with a continuation.
//   r1b A Claude parent hands itself off while its async Claude child runs.
//
// Usage (spawns `apps/server/src/bin.ts start` from --root with an isolated --home):
//   node apps/server/scripts/verify-worktree-handoff-live.ts --row r1 \
//     --root <checkout> --home /tmp/ev/home --repo /tmp/ev/repo --out /tmp/ev/captures/r1
// Against a running server instead (bearer access token with orchestration scopes):
//   node apps/server/scripts/verify-worktree-handoff-live.ts --row r1 \
//     --origin http://127.0.0.1:3773 --token <access-token> --repo /tmp/ev/repo --out <dir>
// --repo is created as a git repository with one commit on main when it does not exist.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
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
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

const { values } = NodeUtil.parseArgs({
  options: {
    row: { type: "string", default: "r1" },
    root: { type: "string", default: NodePath.resolve(import.meta.dirname, "../../..") },
    home: { type: "string" },
    origin: { type: "string" },
    token: { type: "string" },
    repo: { type: "string" },
    out: { type: "string" },
    model: { type: "string", default: "claude-sonnet-5-5" },
    effort: { type: "string", default: "low" },
    timeout: { type: "string", default: "360" },
    settle: { type: "string", default: "45" },
  },
});
const row = values.row;
NodeAssert.ok(["r1", "r2", "r3", "r1b"].includes(row), "row must be r1, r2, r3 or r1b");
NodeAssert.ok(values.repo && values.out, "--repo and --out are required");
NodeAssert.ok(values.origin ? values.token : values.home, "pass --home, or --origin with --token");
const out = NodePath.resolve(values.out);
const repo = NodePath.resolve(values.repo);
const timeoutMs = Number(values.timeout) * 1000;
const settleMs = Number(values.settle) * 1000;
NodeFS.mkdirSync(out, { recursive: true });
const startedAt = Date.now();
const stamp = () => ({ at: new Date().toISOString(), t: Date.now() - startedAt });
const record = (file: string, value: object) =>
  NodeFS.appendFileSync(NodePath.join(out, file), JSON.stringify({ ...stamp(), ...value }) + "\n");
const milestone = (kind: string, detail: object = {}) => {
  record("milestones.ndjson", { kind, ...detail });
  console.log(
    `[${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${kind} ${JSON.stringify(detail)}`,
  );
};

if (!NodeFS.existsSync(repo)) {
  NodeFS.mkdirSync(repo, { recursive: true });
  NodeChildProcess.execFileSync("git", ["init", "-q", "-b", "main", repo]);
  NodeFS.writeFileSync(NodePath.join(repo, "README.md"), "worktree handoff fixture\n");
  NodeChildProcess.execFileSync("git", ["-C", repo, "add", "README.md"]);
  NodeChildProcess.execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=Verifier",
    "-c",
    "user.email=verifier@localhost",
    "commit",
    "-qm",
    "initial",
  ]);
}

const git = (...args: Array<string>) =>
  NodeChildProcess.execFileSync("git", args, { encoding: "utf8" }).trim();

let server: NodeChildProcess.ChildProcess | undefined;
let origin = values.origin ?? "";
let accessToken = values.token ?? "";

async function startServer() {
  const reservation = NodeHttp.createServer();
  reservation.listen(0, "127.0.0.1");
  await new Promise<void>((done) => reservation.once("listening", done));
  const address = reservation.address();
  NodeAssert.ok(address && typeof address !== "string");
  await new Promise<void>((done) => reservation.close(() => done()));
  origin = `http://127.0.0.1:${address.port}`;
  const bootstrap = NodeCrypto.randomUUID();
  server = NodeChildProcess.spawn(
    process.execPath,
    ["apps/server/src/bin.ts", "start", "--bootstrap-fd", "3", "--log-level", "debug"],
    {
      cwd: values.root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      // An ambient T3CODE_HOME outranks the bootstrap home, and the calling agent's Claude
      // session variables would leak into the server's own Claude sessions.
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !/^(T3CODE_|CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_AGENT_SDK)/.test(
              key,
            ),
        ),
      ),
    },
  );
  milestone("server-spawned", { pid: server.pid, origin, root: values.root });
  const bootstrapPipe = server.stdio[3];
  NodeAssert.ok(bootstrapPipe && "write" in bootstrapPipe);
  bootstrapPipe.end(
    JSON.stringify({
      mode: "desktop",
      noBrowser: true,
      port: address.port,
      t3Home: NodePath.resolve(values.home!),
      host: "127.0.0.1",
      desktopBootstrapToken: bootstrap,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    }),
  );
  const ready = Promise.withResolvers<void>();
  let tail = "";
  for (const pipe of [server.stdout, server.stderr])
    pipe?.on("data", (data: Buffer) => {
      const text = data.toString().replaceAll(bootstrap, "[REDACTED]");
      NodeFS.appendFileSync(NodePath.join(out, "server.log"), text);
      tail = (tail + text).slice(-8192);
      if (tail.includes("startup phase: complete")) ready.resolve();
    });
  server.once("exit", (code) => ready.reject(new Error(`Server exited ${code}`)));
  const deadline = setTimeout(() => ready.reject(new Error("Server startup timed out")), 90_000);
  await ready.promise.finally(() => clearTimeout(deadline));
  const response = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: bootstrap,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    }),
  });
  NodeAssert.ok(response.ok, `Authentication failed: ${response.status}`);
  accessToken = decodeAccessToken(await response.json()).access_token;
}

async function stopServer() {
  if (!server?.pid || server.exitCode !== null) return;
  const exited = new Promise<void>((done) => server!.once("exit", () => done()));
  process.kill(-server.pid, "SIGTERM");
  const forced = setTimeout(() => server?.pid && process.kill(-server.pid, "SIGKILL"), 15_000);
  await exited;
  clearTimeout(forced);
  milestone("server-stopped", { pid: server.pid });
}

const decodeAccessToken = Schema.decodeUnknownSync(Schema.Struct({ access_token: Schema.String }));
const decodeTicket = Schema.decodeUnknownSync(Schema.Struct({ ticket: Schema.String }));
const terminal = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);
const continuationText =
  row === "r2"
    ? "Count from 1 to 400, one number per line. No tools."
    : "Reply with the single word DONE. Do not use any tools or edit files.";
const branch = `handoff-${row}-${NodeCrypto.randomUUID().slice(0, 8)}`;
const handoffCall = `t3_worktree_handoff with exactly these arguments: {"branch":"${branch}","baseRef":"main","startFromOrigin":false,"runSetupScript":false,"continuationPrompt":${JSON.stringify(continuationText)}}`;
const childModel = `provider instance claudeAgent, model ${values.model}, options {"effort":"${values.effort}"}`;
const forbid =
  "Do not call any other tool, do not run shell commands, do not read or edit files, and do not delegate.";
const prompt = {
  r1: `This is a live verification. Call the T3 tool delegate_task exactly once with mode="async", ${childModel}, and this task text verbatim: "Call the T3 tool t3_worktree_status once. Then, as your final action, call ${handoffCall}. ${forbid} After the handoff call returns, end your turn immediately with no further text." After delegate_task returns, end your turn with exactly WAITING. When a completion notification for that task arrives, call task_status once for it and reply with exactly ACK: followed by its status. ${forbid}`,
  r2: "",
  r3: `This is a live verification. Call the T3 tool t3_worktree_status once. Then, as your final action, call ${handoffCall}. ${forbid} After the handoff call returns, end your turn immediately with no further text.`,
  r1b: `This is a live verification. First call the T3 tool delegate_task exactly once with mode="async", ${childModel}, and this task text verbatim: "Count from 1 to 300, one number per line. Do not use any tools." Then, as your final action in this turn, call ${handoffCall}. ${forbid} After the handoff call returns, end your turn immediately with no further text. When a completion notification for the delegated task arrives later, call task_status once for it and reply with exactly ACK: followed by its status.`,
}[row === "r2" ? "r1" : row]!;

let verdict: object = { status: "failed", reason: "did not finish" };
const abort = new AbortController();
process.on("SIGINT", () => abort.abort(new Error("interrupted")));
process.on("SIGTERM", () => abort.abort(new Error("interrupted")));
try {
  if (!values.origin) await startServer();
  const headers = {
    Authorization: `Bearer ${accessToken}`,
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
      title: `Worktree handoff ${row}`,
      workspaceRoot: repo,
    }),
  });
  NodeAssert.ok(created.ok, `Project creation failed: ${created.status} ${await created.text()}`);
  const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers,
  });
  NodeAssert.ok(ticketResponse.ok, `WebSocket authentication failed: ${ticketResponse.status}`);
  const ticket = decodeTicket(await ticketResponse.json());
  const layerProtocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(
      Socket.layerWebSocket(
        `${origin.replace("http:", "ws:")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket.ticket)}`,
      ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );
  const parentThreadId = ThreadId.make(NodeCrypto.randomUUID());
  NodeFS.writeFileSync(NodePath.join(out, "prompt.txt"), prompt);
  const program = Effect.gen(function* () {
    const client = yield* RpcClient.make(WsRpcGroup);
    const latest = new Map<string, OrchestrationV2ThreadProjection>();
    const seen = new Set<string>();
    const summarize = (projection: OrchestrationV2ThreadProjection) => ({
      threadId: projection.thread?.id,
      worktreePath: projection.thread?.worktreePath ?? null,
      branch: projection.thread?.branch ?? null,
      runs: projection.runs.map((run) => ({
        id: run.id,
        ordinal: run.ordinal,
        status: run.status,
        queueHeld: run.queueHeld ?? false,
        requestedAt: run.requestedAt,
        startedAt: run.startedAt ?? null,
        completedAt: run.completedAt ?? null,
      })),
      attempts: projection.attempts.map((attempt) => ({
        runId: attempt.runId,
        status: attempt.status,
        completedAt: attempt.completedAt,
      })),
      providerSessions: projection.providerSessions.map((session) => ({
        id: session.id,
        status: session.status,
        cwd: session.cwd,
        model: session.model,
        updatedAt: session.updatedAt,
        lastError: session.lastError,
      })),
      providerTurns: projection.providerTurns.map((turn) => ({
        id: turn.id,
        status: turn.status,
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
      })),
      notifications: projection.turnItems.filter((item) => item.type === "notification").length,
      lastAssistantMessage:
        projection.messages.findLast((message) => message.role === "assistant")?.text ?? null,
      subagents: projection.subagents.map((task) => ({
        id: task.id,
        childThreadId: task.childThreadId,
        status: task.status,
        completionDelivery: task.completionDelivery ?? null,
        result: task.result ?? null,
      })),
    });
    const watch = (threadId: ThreadId, label: string) =>
      client["orchestration.subscribeThread"]({ threadId }).pipe(
        Stream.runForEach(
          Effect.fn(function* (item) {
            record(`${label}.events.ndjson`, { item });
            const projection =
              item.kind === "snapshot"
                ? item.projection
                : yield* client["orchestration.getThreadProjection"]({ threadId });
            latest.set(label, projection);
            const summary = JSON.stringify(summarize(projection));
            if (!seen.has(`${label}:${summary}`)) {
              seen.add(`${label}:${summary}`);
              record(`${label}.states.ndjson`, { state: summarize(projection) });
            }
          }),
        ),
        Effect.tapCause((cause) =>
          Effect.sync(() => milestone("watch-failed", { label, cause: String(cause) })),
        ),
        Effect.forkScoped,
      );
    yield* client["orchestration.launchThread"]({
      commandId: CommandId.make(NodeCrypto.randomUUID()),
      threadId: parentThreadId,
      projectId,
      title: `Worktree handoff ${row}`,
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: values.model,
        options: [{ id: "effort", value: values.effort }],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { text: prompt, attachments: [] },
    });
    milestone("parent-launched", { parentThreadId, branch });
    yield* watch(parentThreadId, "parent");

    let childThreadId: ThreadId | undefined;
    let settleFrom: number | undefined;
    let r2Action: string | undefined;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      yield* Effect.sleep("1 second");
      const parent = latest.get("parent");
      if (!parent) continue;
      if (!childThreadId && parent.subagents[0]?.childThreadId && row !== "r3") {
        childThreadId = parent.subagents[0].childThreadId;
        milestone("child-discovered", { childThreadId });
        yield* watch(childThreadId, "child");
      }
      // The thread that hands off: the child for r1/r2, the parent for r3/r1b.
      const mover = latest.get(row === "r1" || row === "r2" ? "child" : "parent");
      if (!mover) continue;
      const [first, second] = mover.runs;
      if (row === "r2" && second && !r2Action) {
        if (second.status === "running") {
          r2Action = "run.interrupt";
          milestone("r2-dispatch", { action: r2Action, runId: second.id });
          yield* client["orchestration.dispatchCommand"]({
            type: "run.interrupt",
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            threadId: mover.thread!.id,
            runId: second.id,
            reason: "evidence driver interrupt",
          });
        } else if (
          second.status === "queued" &&
          second.queueHeld &&
          first &&
          terminal.has(first.status) &&
          first.completedAt &&
          Date.now() - DateTime.toEpochMillis(first.completedAt) > 15_000
        ) {
          r2Action = "queued-run.cancel";
          milestone("r2-dispatch", { action: r2Action, runId: second.id });
          yield* client["orchestration.dispatchCommand"]({
            type: "queued-run.cancel",
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            threadId: mover.thread!.id,
            runId: second.id,
          });
        }
      }
      const moverSettled =
        first !== undefined &&
        terminal.has(first.status) &&
        second !== undefined &&
        (terminal.has(second.status) || second.queueHeld === true);
      const parentSettled =
        row === "r3" ||
        parent.subagents.every((task) => terminal.has(task.status)) ||
        parent.runs.every((run) => terminal.has(run.status) || run.queueHeld === true);
      if (moverSettled && parentSettled && (row !== "r2" || r2Action)) {
        if (settleFrom === undefined) {
          settleFrom = Date.now();
          milestone("settling");
        }
        if (Date.now() - settleFrom >= settleMs) break;
      } else if (first && terminal.has(first.status) && !second) {
        settleFrom ??= Date.now();
        if (Date.now() - settleFrom >= settleMs * 2) break;
      } else {
        settleFrom = undefined;
      }
    }
    const final: Record<string, unknown> = {};
    for (const [label, threadId] of [
      ["parent", parentThreadId],
      ["child", childThreadId],
    ] as const) {
      if (!threadId) continue;
      const projection = yield* client["orchestration.getThreadProjection"]({ threadId });
      NodeFS.writeFileSync(
        NodePath.join(out, `${label}.projection.json`),
        JSON.stringify(projection, null, 2),
      );
      final[label] = summarize(projection);
    }
    return { row, parentThreadId, childThreadId, branch, r2Action, final };
  }).pipe(Effect.scoped, Effect.provide(layerProtocol));
  const fiber = Effect.runFork(program);
  abort.signal.addEventListener("abort", () => Effect.runFork(Fiber.interrupt(fiber)));
  const result = await Effect.runPromise(Fiber.join(fiber));
  let worktrees = "";
  try {
    worktrees = git("-C", repo, "worktree", "list", "--porcelain");
  } catch {}
  verdict = { status: "captured", ...result, worktrees, elapsedMs: Date.now() - startedAt };
} catch (error) {
  verdict = { status: "failed", reason: String(error), elapsedMs: Date.now() - startedAt };
} finally {
  if (server && values.home) {
    await stopServer();
    const providerLogs = NodePath.join(NodePath.resolve(values.home), "userdata/logs/provider");
    if (NodeFS.existsSync(providerLogs))
      NodeFS.cpSync(providerLogs, NodePath.join(out, "provider-logs"), { recursive: true });
  }
  NodeFS.writeFileSync(NodePath.join(out, "verdict.json"), JSON.stringify(verdict, null, 2));
  console.log(JSON.stringify(verdict, null, 2));
}
