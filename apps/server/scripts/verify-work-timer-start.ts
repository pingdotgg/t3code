// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalDateInEffect:off globalFetch:off globalConsole:off preferSchemaOverJson:off - Host-side evidence driver retains raw wire evidence and owns deadline timers.
// Evidence driver for PR #22947: drives one seeded thread T through agent steers,
// agent/child queued and immediate sends, and user turns, logging the persisted and
// client-received working-timer anchor after each milestone. Same file runs at both SHAs.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Socket } from "effect/socket";
import { RpcClient, RpcSerialization } from "effect/rpc";
import {
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_HEADER,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WsRpcGroup,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

const { values } = NodeUtil.parseArgs({
  options: {
    "home-dir": { type: "string" },
    label: { type: "string" },
    out: { type: "string" },
    model: { type: "string", default: "claude-opus-5-5" },
    provider: { type: "string", default: "claudeAgent" },
  },
});
NodeAssert.ok(values["home-dir"], "--home-dir is required");
NodeAssert.ok(values.label, "--label is required");
const label = values.label;
const home = NodePath.resolve(values["home-dir"]);
const outPath = values.out ?? `/tmp/ev-22947/capture/${label}.log`;
const root = NodePath.resolve(import.meta.dirname, "../../..");
const project = `${home}-project`;
NodeFS.mkdirSync(home, { recursive: true });
NodeFS.mkdirSync(project, { recursive: true });
NodeFS.mkdirSync(NodePath.dirname(outPath), { recursive: true });
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

const iso = (value: unknown): string | null | undefined =>
  value === null || value === undefined
    ? (value as null | undefined)
    : DateTime.isDateTime(value)
      ? DateTime.formatIso(value)
      : String(value);
function log(kind: string, data: Record<string, unknown> = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), label, kind, ...data });
  NodeFS.appendFileSync(outPath, line + "\n");
  console.log(line.length > 600 ? line.slice(0, 600) + "…" : line);
}
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

const serverSha = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
log("environment", {
  root,
  serverSha,
  dirty: NodeChildProcess.execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  }),
  node: process.version,
  provider: values.provider,
  model: values.model,
  driverSha256: NodeCrypto.createHash("sha256")
    .update(NodeFS.readFileSync(import.meta.filename))
    .digest("hex"),
  home,
});

const reservation = NodeHttp.createServer();
reservation.listen(0, "127.0.0.1");
await new Promise<void>((done) => reservation.once("listening", done));
const address = reservation.address();
NodeAssert.ok(address && typeof address !== "string");
await new Promise<void>((done) => reservation.close(() => done()));
const port = address.port;
const origin = `http://127.0.0.1:${port}`;
const bootstrap = NodeCrypto.randomUUID();
const server = NodeChildProcess.spawn(
  process.execPath,
  [
    "apps/server/src/bin.ts",
    "start",
    "--bootstrap-fd",
    "3",
    "--log-level",
    "debug",
    "--base-dir",
    home,
  ],
  {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    // An ambient T3CODE_HOME (e.g. when driven from inside T3) must never reach the live install.
    env: { ...process.env, T3CODE_HOME: home },
  },
);
log("server.spawned", { pid: server.pid, port });
NodeFS.writeFileSync(`${home}.server.pid`, String(server.pid));
const bootstrapPipe = server.stdio[3];
NodeAssert.ok(bootstrapPipe && "write" in bootstrapPipe);
bootstrapPipe.on("error", () => {});
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
let serverOutput = "";
for (const pipe of [server.stdout, server.stderr])
  pipe
    ?.on("error", () => {})
    .on("data", (data: Buffer) => {
      const text = data.toString().replaceAll(bootstrap, "[REDACTED]");
      NodeFS.appendFileSync(`${home}.server.log`, text);
      serverOutput = (serverOutput + text).slice(-8192);
      if (serverOutput.includes("startup phase: complete")) ready.resolve();
    });
server.once("exit", (code) => ready.reject(new Error(`Server exited ${code}`)));
const startupDeadline = setTimeout(
  () => ready.reject(new Error("Server startup timed out")),
  90_000,
);

const db = NodePath.join(home, "userdata", "statev2.sqlite");
function sqlite(query: string): unknown {
  const output = NodeChildProcess.execFileSync("sqlite3", ["-readonly", "-json", db, query], {
    encoding: "utf8",
  });
  return output.trim() === "" ? [] : JSON.parse(output);
}
function persisted(threadId: string) {
  return {
    runs: sqlite(
      `SELECT ordinal, run_id, status, json_extract(payload_json,'$.workStartedAt') AS workStartedAt, json_extract(payload_json,'$.startedAt') AS startedAt, requested_at, json_extract(payload_json,'$.userMessageId') AS userMessageId FROM orchestration_v2_projection_runs WHERE thread_id='${threadId}' ORDER BY ordinal`,
    ),
    messages: sqlite(
      `SELECT message_id, run_id, role, created_at, json_extract(payload_json,'$.createdBy') AS createdBy, json_extract(payload_json,'$.creationSource') AS creationSource, json_extract(payload_json,'$.senderThreadId') AS senderThreadId, json_extract(payload_json,'$.delegatedCompletion') IS NOT NULL AS delegatedCompletion, json_extract(payload_json,'$.notification') IS NOT NULL AS notification, substr(json_extract(payload_json,'$.text'),1,60) AS text FROM orchestration_v2_projection_messages WHERE thread_id='${threadId}' AND role='user' ORDER BY created_at`,
    ),
  };
}

const terminal = ["completed", "failed", "cancelled", "interrupted", "rolled_back"];
const summarizeRuns = (projection: OrchestrationV2ThreadProjection) =>
  projection.runs.map((run) => ({
    ordinal: run.ordinal,
    id: run.id,
    status: run.status,
    userMessageId: run.userMessageId,
    requestedAt: iso(run.requestedAt),
    startedAt: iso(run.startedAt),
    completedAt: iso(run.completedAt),
    workStartedAt: iso(run.workStartedAt),
  }));
const summarizeMessages = (projection: OrchestrationV2ThreadProjection) =>
  projection.messages
    .filter((message) => message.role === "user")
    .map((message) => ({
      id: message.id,
      runId: message.runId,
      createdBy: message.createdBy,
      creationSource: message.creationSource,
      senderThreadId: message.senderThreadId,
      text: message.text.slice(0, 60),
    }));

type State = {
  projections: Map<string, OrchestrationV2ThreadProjection>;
  shell: Map<string, { activityRunStartedAt: string | null | undefined; receivedAt: string }>;
};
const state: State = { projections: new Map(), shell: new Map() };
const waiters = new Set<() => void>();
const notify = () => {
  for (const waiter of waiters) waiter();
};
function waitFor<A>(what: string, check: () => A | undefined, timeoutMs = 420_000): Promise<A> {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      let value: A | undefined;
      try {
        value = check();
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }
      if (value !== undefined) {
        cleanup();
        resolve(value);
      }
    };
    const deadline = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${what}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(deadline);
      waiters.delete(attempt);
    };
    waiters.add(attempt);
    attempt();
  });
}

let exitCode = 0;
try {
  await ready.promise;
  clearTimeout(startupDeadline);
  log("schema", {
    runs: sqlite("PRAGMA table_info(orchestration_v2_projection_runs)"),
    messages: sqlite("PRAGMA table_info(orchestration_v2_projection_messages)"),
  });
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
      title: "Work timer verification",
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
  const layerProtocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(
      Socket.layerWebSocket(
        `${origin.replace("http:", "ws:")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket.ticket)}`,
      ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );

  const T = ThreadId.make(NodeCrypto.randomUUID());
  const C = ThreadId.make(NodeCrypto.randomUUID());
  const modelSelection = {
    instanceId: ProviderInstanceId.make(values.provider),
    model: values.model,
  };
  log("threads", { T, C });

  const program = Effect.gen(function* () {
    const client = yield* RpcClient.make(WsRpcGroup);

    yield* client["orchestration.subscribeShell"]({}).pipe(
      Stream.runForEach((item) =>
        Effect.sync(() => {
          const threads =
            item.kind === "snapshot"
              ? item.snapshot.threads
              : item.kind === "thread.updated"
                ? [item.thread]
                : [];
          for (const thread of threads) {
            const next = iso(thread.activityRunStartedAt);
            const previous = state.shell.get(thread.id);
            if (previous === undefined || previous.activityRunStartedAt !== next) {
              const receivedAt = new Date().toISOString();
              state.shell.set(thread.id, { activityRunStartedAt: next, receivedAt });
              log("shell.activityRunStartedAt", {
                threadId: thread.id,
                role: thread.id === T ? "T" : thread.id === C ? "C" : "other",
                activityRunStartedAt: next,
                previous: previous?.activityRunStartedAt,
              });
            }
          }
          notify();
        }),
      ),
      Effect.forkScoped,
    );

    const watchThread = (threadId: ThreadId, role: string) =>
      client["orchestration.subscribeThread"]({ threadId }).pipe(
        Stream.runForEach(
          Effect.fn(function* (item) {
            const projection =
              item.kind === "snapshot"
                ? item.projection
                : yield* client["orchestration.getThreadProjection"]({ threadId });
            const before = state.projections.get(threadId);
            state.projections.set(threadId, projection);
            const runs = summarizeRuns(projection);
            if (JSON.stringify(runs) !== JSON.stringify(before ? summarizeRuns(before) : null))
              log("thread.runs", { role, threadId, runs });
            const messages = summarizeMessages(projection);
            if (
              JSON.stringify(messages) !== JSON.stringify(before ? summarizeMessages(before) : null)
            )
              log("thread.userMessages", { role, threadId, messages });
            const subagents = projection.subagents.map((task) => ({
              origin: task.origin,
              childThreadId: task.childThreadId,
              status: task.status,
              completionDelivery: task.completionDelivery?.state,
            }));
            if (
              JSON.stringify(subagents) !==
              JSON.stringify(
                before?.subagents.map((task) => ({
                  origin: task.origin,
                  childThreadId: task.childThreadId,
                  status: task.status,
                  completionDelivery: task.completionDelivery?.state,
                })) ?? null,
              )
            )
              log("thread.subagents", { role, threadId, subagents });
            notify();
          }),
        ),
        Effect.forkScoped,
      );

    const dispatchUser = (threadId: ThreadId, text: string) =>
      client["orchestration.dispatchCommand"]({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        threadId,
        messageId: MessageId.make(NodeCrypto.randomUUID()),
        text,
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      });
    const wait = <A>(what: string, check: () => A | undefined, timeoutMs?: number) =>
      Effect.promise(() => waitFor(what, check, timeoutMs));
    const projectionOf = (threadId: ThreadId) => state.projections.get(threadId);
    const runForText = (marker: string) => {
      const projection = projectionOf(T);
      const message = projection?.messages.find(
        // Parent prompts quote child markers, so only a message that leads with one counts.
        (candidate) => candidate.role === "user" && candidate.text.startsWith(marker),
      );
      return message === undefined
        ? undefined
        : { message, run: projection?.runs.find((run) => run.userMessageId === message.id) };
    };
    const milestone = (row: string, note: Record<string, unknown> = {}) => {
      const projection = projectionOf(T);
      const shell = state.shell.get(T);
      log("milestone", {
        row,
        ...note,
        runCount: projection?.runs.length,
        clientRuns: projection ? summarizeRuns(projection) : null,
        clientShellActivityRunStartedAt: shell?.activityRunStartedAt,
        clientShellReceivedAt: shell?.receivedAt,
        persisted: persisted(T),
      });
    };
    const quiescent = () => {
      const projection = projectionOf(T);
      if (projection === undefined) return undefined;
      const idle =
        projection.runs.every((run) => terminal.includes(run.status)) &&
        projection.subagents.every(
          (task) =>
            !["pending", "running", "waiting"].includes(task.status) &&
            task.completionDelivery?.state !== "pending",
        );
      return idle ? true : undefined;
    };
    const coordinatorSend = Effect.fn(function* (row: string, args: object) {
      const before = projectionOf(C)?.runs.length ?? 0;
      yield* dispatchUser(
        C,
        `Call the t3-code MCP tool t3_thread_send exactly once with exactly these JSON arguments: ${JSON.stringify(args)}. Do not change any argument, do not call any other tool, and do not retry. Then reply exactly SENT.`,
      );
      log("coordinator.dispatched", { row, args });
      return before;
    });
    const childTask = (marker: string, sleepSeconds: number) =>
      `Run \`sleep ${sleepSeconds}\` in Bash with a timeout of 600000 ms. Then call the t3-code MCP tool t3_thread_send exactly once with exactly these JSON arguments: ${JSON.stringify({ threadId: T, message: `${marker}: child update. Reply exactly ACK and call no tools.`, mode: "queue" })}. Do not change any argument or retry. Then reply exactly CHILDDONE.`;

    // Coordinator C: an ordinary thread whose agent sends to T over MCP.
    yield* client["orchestration.launchThread"]({
      commandId: CommandId.make(NodeCrypto.randomUUID()),
      threadId: C,
      projectId,
      title: "Coordinator C",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { text: "Reply exactly READY and call no tools.", attachments: [] },
    });
    yield* watchThread(C, "C");
    yield* wait("C ready", () =>
      projectionOf(C)?.runs[0]?.status === "completed" ? true : undefined,
    );

    // R0: baseline user turn on T held open by sleep.
    yield* client["orchestration.launchThread"]({
      commandId: CommandId.make(NodeCrypto.randomUUID()),
      threadId: T,
      projectId,
      title: "Target T",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: {
        text: "USER-R0: Run `sleep 110` in Bash with a timeout of 600000 ms. Then reply exactly DONE1. Call no other tools.",
        attachments: [],
      },
    });
    yield* watchThread(T, "T");
    yield* wait("R0 running", () => {
      const run = projectionOf(T)?.runs[0];
      return run?.status === "running" && run.startedAt !== null && state.shell.get(T)
        ? run
        : undefined;
    });
    yield* wait("R0 provider turn running", () =>
      projectionOf(T)?.providerTurns.some((turn) => turn.status === "running") ? true : undefined,
    );
    milestone("R0");

    // R1: agent steer from C while T sleeps.
    yield* Effect.promise(() => delay(15_000));
    const cRunsR1 = yield* coordinatorSend("R1", {
      threadId: T,
      message: "AGENT-STEER-R1: no action needed. Keep doing what you are doing.",
      mode: "steer",
    });
    yield* wait("R1 steer recorded on T", () => runForText("AGENT-STEER-R1")?.message);
    yield* wait("C finished R1", () => {
      const runs = projectionOf(C)?.runs ?? [];
      return runs.length > cRunsR1 && terminal.includes(runs.at(-1)!.status) ? true : undefined;
    });
    milestone("R1", { steerRun: runForText("AGENT-STEER-R1")?.run?.ordinal ?? null });

    // R2: C queues behind running T; it drains automatically when run 1 ends.
    // That run also delegates child K, which queues back to T while T sleeps (R3).
    const cRunsR2 = yield* coordinatorSend("R2", {
      threadId: T,
      message: `AGENT-QUEUE-R2: Use the t3-code MCP tool delegate_task exactly once with mode "async", target provider instance ${values.provider} and model ${values.model}, and this task: ${childTask("CHILD-QUEUE-R3", 20)} After delegating, run \`sleep 75\` in Bash with a timeout of 600000 ms, then reply exactly DONE2. Do not poll the child or call task_status.`,
      mode: "queue",
    });
    yield* wait("R2 message on T", () => runForText("AGENT-QUEUE-R2")?.message);
    yield* wait("C finished R2", () => {
      const runs = projectionOf(C)?.runs ?? [];
      return runs.length > cRunsR2 && terminal.includes(runs.at(-1)!.status) ? true : undefined;
    });
    milestone("R2-queued");
    yield* wait("R2 run started", () => {
      const run = runForText("AGENT-QUEUE-R2")?.run;
      return run?.startedAt ? run : undefined;
    });
    yield* wait("R2 shell anchor delivered", () =>
      state.shell.get(T) && runForText("AGENT-QUEUE-R2")?.run?.status === "running"
        ? true
        : undefined,
    );
    yield* Effect.promise(() => delay(1_000));
    milestone("R2");

    yield* wait("R3 message on T", () => runForText("CHILD-QUEUE-R3")?.message);
    milestone("R3-queued");
    yield* wait("R3 run started", () => {
      const run = runForText("CHILD-QUEUE-R3")?.run;
      return run?.startedAt ? run : undefined;
    });
    yield* Effect.promise(() => delay(1_000));
    milestone("R3");

    yield* wait("T quiescent after R3", quiescent);
    milestone("R10a-quiescent");

    // R9: a genuinely new user turn on the same T, after a deliberate idle gap.
    // It delegates child K2 and ends; K2 then sends to idle T (R4).
    yield* Effect.promise(() => delay(20_000));
    yield* wait("T still quiescent", quiescent);
    yield* dispatchUser(
      T,
      `USER-R9: Use the t3-code MCP tool delegate_task exactly once with mode "async", target provider instance ${values.provider} and model ${values.model}, and this task: ${childTask("CHILD-IMMEDIATE-R4", 30)} Then immediately end your turn by replying exactly DELEGATED. Do not wait, poll, or call any other tool.`,
    );
    yield* wait("R9 run started", () => {
      const run = runForText("USER-R9")?.run;
      return run?.startedAt ? run : undefined;
    });
    yield* Effect.promise(() => delay(1_000));
    milestone("R9");
    yield* wait("R9 run ended", () =>
      terminal.includes(runForText("USER-R9")?.run?.status ?? "") ? true : undefined,
    );
    milestone("R9-ended");
    yield* wait("R4 run started", () => {
      const run = runForText("CHILD-IMMEDIATE-R4")?.run;
      return run?.startedAt ? run : undefined;
    });
    yield* Effect.promise(() => delay(1_000));
    milestone("R4", {
      tIdleWhenR4Arrived:
        (runForText("USER-R9")?.run?.completedAt ?? null) !== null &&
        (projectionOf(T)?.runs ?? []).filter((run) => !terminal.includes(run.status)).length <= 1,
    });

    yield* wait("T quiescent after R4", quiescent);
    milestone("R10b-quiescent");

    // R5 control: unrelated agent C sends to idle T (immediate). It holds T so
    // R8, an outside CLI caller with no sender thread, can queue behind it.
    yield* Effect.promise(() => delay(20_000));
    yield* coordinatorSend("R5", {
      threadId: T,
      message:
        "AGENT-IDLE-R5: Run `sleep 45` in Bash with a timeout of 600000 ms, then reply exactly ACK5. Call no other tools.",
      mode: "queue",
    });
    yield* wait("R5 run started", () => {
      const run = runForText("AGENT-IDLE-R5")?.run;
      return run?.startedAt ? run : undefined;
    });
    yield* wait("R5 provider turn running", () =>
      projectionOf(T)?.providerTurns.some((turn) => turn.status === "running") ? true : undefined,
    );
    yield* Effect.promise(() => delay(1_000));
    milestone("R5");
    const cli = yield* Effect.promise(
      () =>
        new Promise<{ code: number | null; output: string }>((done) => {
          const child = NodeChildProcess.spawn(
            process.execPath,
            [
              "apps/server/src/bin.ts",
              "thread",
              "send",
              "--base-dir",
              home,
              T,
              "CLI-R8: Reply exactly ACK8 and call no tools.",
            ],
            { cwd: root, env: { ...process.env, T3CODE_HOME: home } },
          );
          let output = "";
          child.stdout.on("data", (data: Buffer) => (output += data.toString()));
          child.stderr.on("data", (data: Buffer) => (output += data.toString()));
          child.once("exit", (code) => done({ code, output: output.slice(-2000) }));
        }),
    );
    log("cli.R8", cli);
    if (cli.code === 0) {
      yield* wait("R8 run started", () => {
        const run = runForText("CLI-R8")?.run;
        return run?.startedAt ? run : undefined;
      });
      yield* Effect.promise(() => delay(1_000));
      milestone("R8");
    }
    yield* wait("T quiescent after R8", quiescent);
    milestone("R8-quiescent");

    // R6/R7 controls: agent C queues behind a running user turn, the user stops
    // the thread (holding the queue), then resumes the queue (R6) or sends the
    // held message now (R7). Both are explicit-queue starts.
    const heldQueueRow = Effect.fn(function* (
      row: string,
      release: "queue.resume" | "queued-run.start",
    ) {
      yield* Effect.promise(() => delay(20_000));
      yield* wait(`T quiescent before ${row}`, quiescent);
      yield* dispatchUser(
        T,
        `USER-HOLD-${row}: Run \`sleep 90\` in Bash with a timeout of 600000 ms, then reply exactly DONE. Call no other tools.`,
      );
      const hold = yield* wait(`${row} hold run started`, () => {
        const run = runForText(`USER-HOLD-${row}`)?.run;
        return run?.startedAt ? run : undefined;
      });
      yield* wait(`${row} hold provider turn running`, () =>
        projectionOf(T)?.providerTurns.some((turn) => turn.status === "running") ? true : undefined,
      );
      yield* Effect.promise(() => delay(15_000));
      yield* coordinatorSend(row, {
        threadId: T,
        message: `AGENT-HELD-${row}: Reply exactly ACK and call no tools.`,
        mode: "queue",
      });
      const queued = yield* wait(`${row} queued run`, () => {
        const run = runForText(`AGENT-HELD-${row}`)?.run;
        return run?.status === "queued" ? run : undefined;
      });
      milestone(`${row}-queued`);
      yield* client["orchestration.dispatchCommand"]({
        type: "thread.stop",
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        threadId: T,
      });
      log("thread.stop.dispatched", { row });
      yield* wait(`${row} hold run stopped`, () =>
        terminal.includes(projectionOf(T)?.runs.find((run) => run.id === hold.id)?.status ?? "")
          ? true
          : undefined,
      );
      milestone(`${row}-stopped`);
      yield* client["orchestration.dispatchCommand"](
        release === "queue.resume"
          ? {
              type: "queue.resume",
              commandId: CommandId.make(NodeCrypto.randomUUID()),
              threadId: T,
            }
          : {
              type: "queued-run.start",
              commandId: CommandId.make(NodeCrypto.randomUUID()),
              threadId: T,
              runId: queued.id,
            },
      );
      log(`${release}.dispatched`, { row, runId: queued.id });
      yield* wait(`${row} run started`, () => {
        const run = runForText(`AGENT-HELD-${row}`)?.run;
        return run?.startedAt ? run : undefined;
      });
      yield* Effect.promise(() => delay(1_000));
      milestone(row);
    });
    yield* heldQueueRow("R6", "queue.resume");
    yield* heldQueueRow("R7", "queued-run.start");
    yield* wait("T quiescent after R7", quiescent);
    milestone("final", {
      tProjectionSubagents: projectionOf(T)?.subagents.map((task) => ({
        origin: task.origin,
        childThreadId: task.childThreadId,
        status: task.status,
      })),
    });
  }).pipe(Effect.scoped, Effect.provide(layerProtocol), Effect.timeout(1_500_000));
  await Effect.runPromise(program);
  log("done");
} catch (error) {
  exitCode = 1;
  log("error", { error: String(error), stack: error instanceof Error ? error.stack : undefined });
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    const stopped = new Promise<void>((done) => server.once("exit", () => done()));
    server.kill("SIGTERM");
    const deadline = setTimeout(() => server.kill("SIGKILL"), 10_000);
    await stopped;
    clearTimeout(deadline);
  }
  if (server.pid) {
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
  log("server.stopped", { pid: server.pid });
  process.exit(exitCode);
}
