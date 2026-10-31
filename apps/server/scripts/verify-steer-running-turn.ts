// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalDateInEffect:off globalFetch:off globalConsole:off preferSchemaOverJson:off - Host-side process verifier retains raw wire evidence and owns deadline timers.
/**
 * Live check that an explicit Steer or Restart sent while the active run's
 * provider turn is `running` reaches that run instead of queueing a new one.
 *
 *   node apps/server/scripts/verify-steer-running-turn.ts --home /tmp/home --port 47311 \
 *     --project /tmp/proj --out /tmp/steer.json [--intent steer|restart] [--server-root <checkout>]
 *
 * `--server-root` runs the server from another checkout so one driver compares two builds.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Socket } from "effect/socket";
import { RpcClient, RpcSerialization } from "effect/rpc";
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
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
    home: { type: "string" },
    port: { type: "string" },
    project: { type: "string" },
    out: { type: "string" },
    intent: { type: "string", default: "steer" },
    "server-root": { type: "string" },
    provider: { type: "string", default: "claudeAgent" },
    model: { type: "string", default: "claude-sonnet-5-5" },
    timeout: { type: "string", default: "300" },
  },
});
NodeAssert.ok(values.home && values.port && values.project && values.out, "missing arguments");
NodeAssert.ok(values.intent === "steer" || values.intent === "restart", "intent: steer|restart");
NodeAssert.ok(
  !NodePath.resolve(values.home).startsWith(NodePath.join(NodeOS.homedir(), ".t3")),
  "--home must be an isolated directory, never the live T3 home",
);
const intent: "steer" | "restart" = values.intent === "restart" ? "restart" : "steer";
const port = Number(values.port);
const timeoutMs = Number(values.timeout) * 1000;
const serverRoot = NodePath.resolve(
  values["server-root"] ?? NodePath.join(import.meta.dirname, "../../.."),
);
const origin = `http://127.0.0.1:${port}`;
const marker = intent === "steer" ? "ROW7" : "ROW9";
const firstPrompt = `Do not use any tools or edit files. Count slowly from 1 to 150, one number per line, then say ${marker}_FIRST_DONE.`;
const secondPrompt =
  intent === "steer"
    ? `Do not use any tools. Stop counting and say ${marker}_STEERED.`
    : `Do not use any tools. Say ${marker}_RESTARTED.`;

const startedAt = new Date().toISOString();
const timeline: Array<{ at: string; event: string; detail?: unknown }> = [];
const note = (event: string, detail?: unknown) => {
  timeline.push({
    at: new Date().toISOString(),
    event,
    ...(detail === undefined ? {} : { detail }),
  });
  console.log(`[${event}]`, detail === undefined ? "" : JSON.stringify(detail));
};

const bootstrap = NodeCrypto.randomUUID();
const server = NodeChildProcess.spawn(
  process.execPath,
  [
    "apps/server/src/bin.ts",
    "start",
    "--bootstrap-fd",
    "3",
    "--base-dir",
    values.home,
    "--log-level",
    "debug",
  ],
  {
    cwd: serverRoot,
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    // An ambient T3CODE_HOME outranks the bootstrap t3Home and would point at live state.
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("T3CODE_")),
    ),
  },
);
const bootstrapPipe = server.stdio[3];
NodeAssert.ok(bootstrapPipe && "write" in bootstrapPipe);
// The server closes its end once it has read the bootstrap secrets.
bootstrapPipe.on("error", () => {});
bootstrapPipe.end(
  JSON.stringify({
    mode: "desktop",
    noBrowser: true,
    port,
    t3Home: values.home,
    host: "127.0.0.1",
    desktopBootstrapToken: bootstrap,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  }),
);
const serverLog = `${values.out.replace(/\.json$/, "")}.server.log`;
const ready = Promise.withResolvers<void>();
let recentOutput = "";
for (const pipe of [server.stdout, server.stderr])
  pipe?.on("data", (data: Buffer) => {
    const text = data.toString().replaceAll(bootstrap, "[REDACTED]");
    NodeFS.appendFileSync(serverLog, text);
    recentOutput = (recentOutput + text).slice(-8192);
    if (recentOutput.includes("startup phase: complete")) ready.resolve();
  });
server.once("exit", (code) => ready.reject(new Error(`Server exited ${code}`)));
const startupDeadline = setTimeout(
  () => ready.reject(new Error("Server startup timed out")),
  90_000,
);
note("server-spawned", { pid: server.pid, serverRoot });

const summarize = (projection: OrchestrationV2ThreadProjection) => ({
  runs: projection.runs.map((run) => ({
    id: run.id,
    ordinal: run.ordinal,
    status: run.status,
    userMessageId: run.userMessageId,
    activeAttemptId: run.activeAttemptId,
    restartContinuationOfRunId: run.restartContinuationOfRunId ?? null,
  })),
  attempts: projection.attempts.map((attempt) => ({
    id: attempt.id,
    runId: attempt.runId,
    status: attempt.status,
    reason: attempt.reason,
  })),
  providerTurns: projection.providerTurns.map((turn) => ({
    id: turn.id,
    runAttemptId: turn.runAttemptId,
    status: turn.status,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
  })),
  userMessages: projection.turnItems.flatMap((item) =>
    item.type === "user_message"
      ? [{ messageId: item.messageId, runId: item.runId, inputIntent: item.inputIntent }]
      : [],
  ),
  assistantMarkers: projection.messages
    .filter((message) => message.role === "assistant")
    .map((message) => ({
      runId: message.runId,
      markers: [...message.text.matchAll(/ROW\d_[A-Z_]+/g)].map((match) => match[0]),
      tail: message.text.slice(-120),
    })),
});

const terminal = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);
let result: Record<string, unknown> = { status: "failed", reason: "did not finish" };
try {
  await ready.promise.finally(() => clearTimeout(startupDeadline));
  note("server-ready");
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
      title: "Steer evidence",
      workspaceRoot: values.project,
    }),
  });
  NodeAssert.ok(created.ok, `Project creation failed: ${created.status} ${await created.text()}`);
  const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers,
  });
  NodeAssert.ok(ticketResponse.ok, `WebSocket ticket failed: ${ticketResponse.status}`);
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

  const threadId = ThreadId.make(NodeCrypto.randomUUID());
  const secondMessageId = MessageId.make(NodeCrypto.randomUUID());
  let dispatch: Record<string, unknown> | undefined;
  const program = Effect.gen(function* () {
    const client = yield* RpcClient.make(WsRpcGroup);
    yield* client["orchestration.launchThread"]({
      commandId: CommandId.make(NodeCrypto.randomUUID()),
      threadId,
      projectId,
      title: `Steer evidence ${marker}`,
      modelSelection: { instanceId: ProviderInstanceId.make(values.provider), model: values.model },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { text: firstPrompt, attachments: [] },
    });
    note("thread-launched", { threadId });
    return yield* client["orchestration.subscribeThread"]({ threadId }).pipe(
      Stream.mapEffect(
        Effect.fn(function* (item) {
          const projection =
            item.kind === "snapshot"
              ? item.projection
              : yield* client["orchestration.getThreadProjection"]({ threadId });
          const activeRun = projection.runs.findLast(
            (run) => !terminal.has(run.status) && run.status !== "queued",
          );
          const runningTurn = projection.providerTurns.find(
            (turn) =>
              activeRun !== undefined &&
              turn.runAttemptId === activeRun.activeAttemptId &&
              turn.status === "running",
          );
          if (dispatch === undefined && activeRun?.status === "running" && runningTurn) {
            const observed = {
              at: new Date().toISOString(),
              activeRunId: activeRun.id,
              activeRunStatus: activeRun.status,
              activeAttemptId: activeRun.activeAttemptId,
              providerTurnId: runningTurn.id,
              providerTurnStatus: runningTurn.status,
              runCount: projection.runs.length,
            };
            note("observed-running-provider-turn", observed);
            // Same shape the web composer sends when the server resolves delivery.
            const request = {
              type: "message.dispatch" as const,
              commandId: CommandId.make(NodeCrypto.randomUUID()),
              createdBy: "user" as const,
              creationSource: "web" as const,
              threadId,
              messageId: secondMessageId,
              text: secondPrompt,
              attachments: [],
              deliveryIntent: intent,
              dispatchMode: { type: "start_immediately" as const },
            };
            const response = yield* client["orchestration.dispatchCommand"](request).pipe(
              Effect.map((success) => ({ ok: true, success })),
              Effect.catch((error) => Effect.succeed({ ok: false, error: String(error) })),
            );
            dispatch = { observedAtDispatch: observed, request, response };
            note("dispatched", { response });
          }
          const done =
            dispatch !== undefined &&
            projection.runs.length > 0 &&
            projection.runs.every((run) => terminal.has(run.status));
          return { projection, done };
        }),
      ),
      Stream.takeUntil((step) => step.done),
      Stream.runLast,
    );
  }).pipe(Effect.provide(layerProtocol), Effect.scoped, Effect.timeout(timeoutMs));
  const last = await Effect.runPromise(program);
  NodeAssert.ok(last._tag === "Some", "subscription ended without a projection");
  const final = summarize(last.value.projection);
  const steerItem = final.userMessages.find((message) => message.messageId === secondMessageId);
  const firstRunId = final.runs[0]?.id ?? null;
  result = {
    status: "finished",
    intent,
    dispatch,
    resolved: {
      secondMessageInputIntent: steerItem?.inputIntent ?? null,
      secondMessageRunId: steerItem?.runId ?? null,
      firstRunId,
      deliveredIntoActiveRun: steerItem?.runId === firstRunId,
      runCount: final.runs.length,
      runsWithSecondMessageAsUserMessage: final.runs
        .filter((run) => run.userMessageId === secondMessageId)
        .map((run) => run.id),
    },
    final,
  };
} catch (error) {
  result = { status: "failed", reason: String(error) };
  process.exitCode = 1;
} finally {
  const git = (args: Array<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd: serverRoot, encoding: "utf8" }).trim();
  NodeFS.writeFileSync(
    values.out,
    JSON.stringify(
      {
        environment: {
          serverRoot,
          serverSha: git(["rev-parse", "HEAD"]),
          serverDirty: git(["status", "--porcelain", "--untracked-files=no"]),
          node: process.version,
          os: NodeChildProcess.execFileSync("uname", ["-srm"], { encoding: "utf8" }).trim(),
          provider: values.provider,
          model: values.model,
          port,
        },
        startedAt,
        finishedAt: new Date().toISOString(),
        prompts: { first: firstPrompt, second: secondPrompt },
        ...result,
        timeline,
      },
      null,
      2,
    ),
  );
  console.log(`Transcript: ${values.out}`);
  await stopServer();
}

async function stopServer() {
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
}
