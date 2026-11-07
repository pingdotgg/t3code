// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off globalConsole:off preferSchemaOverJson:off - Host-side evidence driver retains raw wire evidence and owns deadline timers.
/**
 * Evidence driver for issue #22796: fork a Claude thread after its project's
 * workspaceRoot moved. Starts a real server from this checkout with isolated
 * T3 and Claude homes, then runs real Claude turns:
 *
 * - control: fork twice with the root unchanged, run each fork, merge both back.
 * - moved:   move the project root, fork twice, run each fork, merge both back,
 *            then continue the source thread.
 *
 * Usage: node apps/server/scripts/evidence/pr-22836-fork-moved-root.ts --out <dir>
 * Writes summary.json, per-thread projections, server.log, and a Claude
 * transcript listing into <dir>. Never touches ~/.t3 or ~/.claude.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
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
  type RunId,
} from "@t3tools/contracts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", default: "claude-sonnet-4-6" },
    timeout: { type: "string", default: "300" },
  },
});
NodeAssert.ok(values.out, "--out <dir> is required");
const evidence = NodePath.resolve(values.out);
const turnTimeoutMs = Number(values.timeout) * 1000;
const root = NodePath.resolve(import.meta.dirname, "../../../..");
const t3Home = NodePath.join(evidence, "t3-home");
const claudeHome = NodePath.join(evidence, "claude-home");
const workspaces = NodePath.join(evidence, "workspaces");
NodeFS.mkdirSync(claudeHome, { recursive: true });
NodeFS.mkdirSync(workspaces, { recursive: true });

// Seed the isolated Claude home with only the host's settings `env` block
// (provider endpoint and auth), never credentials directories.
const HostClaudeSettings = Schema.Struct({
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const hostSettings = Schema.decodeUnknownSync(HostClaudeSettings)(
  JSON.parse(
    NodeFS.readFileSync(NodePath.join(NodeOS.homedir(), ".claude", "settings.json"), "utf8"),
  ),
);
const claudeEnv = Object.fromEntries(
  Object.entries(hostSettings.env ?? {}).filter(([key]) =>
    ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "NODE_EXTRA_CA_CERTS"].includes(key),
  ),
);
NodeFS.writeFileSync(
  NodePath.join(claudeHome, "settings.json"),
  JSON.stringify({ env: claudeEnv }, null, 2),
);

const log = (line: string) => {
  console.log(line);
  NodeFS.appendFileSync(NodePath.join(evidence, "driver.log"), line + "\n");
};
const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
const makeRepo = (name: string) => {
  const dir = NodePath.join(workspaces, name);
  NodeFS.mkdirSync(dir);
  git(dir, "init", "-q");
  NodeFS.writeFileSync(NodePath.join(dir, "README.md"), `# ${name}\n`);
  git(dir, "add", ".");
  git(
    dir,
    "-c",
    "user.name=Evidence",
    "-c",
    "user.email=evidence@localhost",
    "commit",
    "-qm",
    "init",
  );
  return dir;
};

const revision = git(root, "rev-parse", "HEAD");
log(`revision ${revision}`);
log(
  `claude ${NodeChildProcess.execFileSync("claude", ["--version"], { encoding: "utf8" }).trim()}`,
);

const reservation = NodeHttp.createServer();
reservation.listen(0, "127.0.0.1");
await new Promise<void>((done) => reservation.once("listening", done));
const address = reservation.address();
NodeAssert.ok(address && typeof address !== "string");
await new Promise<void>((done) => reservation.close(() => done()));
const origin = `http://127.0.0.1:${address.port}`;
const bootstrap = NodeCrypto.randomUUID();

const server = NodeChildProcess.spawn(
  process.execPath,
  [
    "apps/server/src/bin.ts",
    "start",
    "--base-dir",
    t3Home,
    "--bootstrap-fd",
    "3",
    "--log-level",
    "debug",
  ],
  {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    // Same CLAUDE_CONFIG_DIR as the host process, so the adapter takes the
    // in-process fork path (the default-home case in the issue).
    // An ambient T3CODE_HOME (the live install) must never win.
    env: { ...process.env, ...claudeEnv, T3CODE_HOME: t3Home, CLAUDE_CONFIG_DIR: claudeHome },
  },
);
log(`server pid ${server.pid}`);
NodeFS.writeFileSync(NodePath.join(evidence, "server.pid"), String(server.pid));
const bootstrapPipe = server.stdio[3];
NodeAssert.ok(bootstrapPipe && "write" in bootstrapPipe);
bootstrapPipe.end(
  JSON.stringify({
    mode: "desktop",
    noBrowser: true,
    port: address.port,
    t3Home,
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
    NodeFS.appendFileSync(NodePath.join(evidence, "server.log"), text);
    tail = (tail + text).slice(-8192);
    if (tail.includes("startup phase: complete")) ready.resolve();
  });
server.once("exit", (code) => ready.reject(new Error(`Server exited ${code}`)));
const startupDeadline = setTimeout(() => ready.reject(new Error("startup timed out")), 90_000);
const stopServer = () => {
  if (server.pid !== undefined && server.exitCode === null) process.kill(-server.pid, "SIGTERM");
};
process.on("SIGINT", stopServer);
process.on("SIGTERM", stopServer);

const terminal = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);

try {
  await ready.promise;
  clearTimeout(startupDeadline);
  const tokenResponse = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: bootstrap,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    }),
  });
  NodeAssert.ok(tokenResponse.ok, `auth failed: ${tokenResponse.status}`);
  const token = Schema.decodeUnknownSync(Schema.Struct({ access_token: Schema.String }))(
    await tokenResponse.json(),
  );
  const headers = {
    Authorization: `Bearer ${token.access_token}`,
    "Content-Type": "application/json",
    [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
  };
  const mutateProject = async (body: Record<string, string>) => {
    const response = await fetch(`${origin}/api/projects/mutate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ commandId: NodeCrypto.randomUUID(), ...body }),
    });
    NodeAssert.ok(response.ok, `${body.type} failed: ${response.status} ${await response.text()}`);
  };
  const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers,
  });
  NodeAssert.ok(ticketResponse.ok, `websocket ticket failed: ${ticketResponse.status}`);
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
  const modelSelection = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: values.model,
  };

  const program = Effect.gen(function* () {
    const client = yield* RpcClient.make(WsRpcGroup);
    const projection = (threadId: ThreadId) =>
      client["orchestration.getThreadProjection"]({ threadId });
    const save = (label: string, value: OrchestrationV2ThreadProjection) =>
      NodeFS.writeFileSync(
        NodePath.join(evidence, `projection-${label}.json`),
        JSON.stringify(value, null, 2),
      );
    // Waits until the thread has `runs` runs and all are terminal. A fork whose
    // provider fork failed may never create a run, so time out into a snapshot.
    const settle = Effect.fn(function* (threadId: ThreadId, runs: number) {
      const deadline = (yield* Clock.currentTimeMillis) + turnTimeoutMs;
      while (true) {
        const current = yield* projection(threadId);
        const done =
          current.runs.length >= runs && current.runs.every((run) => terminal.has(run.status));
        if (done || (yield* Clock.currentTimeMillis) > deadline) return current;
        yield* Effect.sleep("1 second");
      }
    });
    const lastRunId = (value: OrchestrationV2ThreadProjection): RunId => {
      const run = value.runs.at(-1);
      NodeAssert.ok(run, `thread ${value.thread.id} has no run`);
      return run.id;
    };
    const send = (threadId: ThreadId, text: string) =>
      client["orchestration.dispatchCommand"]({
        type: "message.dispatch",
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        createdBy: "user",
        creationSource: "web",
        threadId,
        messageId: MessageId.make(NodeCrypto.randomUUID()),
        text,
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      });
    const summarize = (label: string, value: OrchestrationV2ThreadProjection) => ({
      label,
      threadId: value.thread.id,
      forkedFrom: value.thread.forkedFrom,
      runs: value.runs.map((run) => run.status),
      providerThreads: value.providerThreads.map((thread) => ({
        status: thread.status,
        nativeId: thread.nativeThreadRef?.nativeId ?? null,
        headRef: thread.nativeConversationHeadRef?.nativeId ?? null,
        forkedFrom: thread.forkedFrom,
      })),
      contextTransfers: value.contextTransfers.map((transfer) => ({
        type: transfer.type,
        source: transfer.sourceThreadId,
        target: transfer.targetThreadId,
        status: transfer.status,
        strategy: transfer.resolution?.strategy ?? null,
        error: transfer.error,
      })),
      assistant: value.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.text.slice(0, 200)),
    });

    const scenario = Effect.fn(function* (name: "control" | "moved") {
      const dirA = makeRepo(`${name}-a`);
      const projectId = ProjectId.make(NodeCrypto.randomUUID());
      yield* Effect.promise(() =>
        mutateProject({
          type: "project.create",
          projectId,
          title: `PR 22836 ${name}`,
          workspaceRoot: dirA,
        }),
      );
      const sourceId = ThreadId.make(NodeCrypto.randomUUID());
      yield* client["orchestration.launchThread"]({
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        threadId: sourceId,
        projectId,
        title: `${name} source`,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: {
          text: "Reply with exactly: source ok. Do not use tools.",
          attachments: [],
        },
      });
      const source = yield* settle(sourceId, 1);
      log(`[${name}] source runs=${source.runs.map((run) => run.status).join(",")}`);
      const sourceRunId = lastRunId(source);
      let dirB: string | null = null;
      if (name === "moved") {
        dirB = NodePath.join(workspaces, `${name}-b`);
        NodeFS.cpSync(dirA, dirB, { recursive: true });
        yield* Effect.promise(() =>
          mutateProject({ type: "project.update", projectId, workspaceRoot: dirB ?? dirA }),
        );
        log(`[${name}] workspaceRoot ${dirA} -> ${dirB}`);
      }
      const forks: Array<OrchestrationV2ThreadProjection> = [];
      for (const sibling of ["a", "b"]) {
        const forkId = ThreadId.make(NodeCrypto.randomUUID());
        yield* client["orchestration.dispatchCommand"]({
          type: "thread.fork",
          commandId: CommandId.make(NodeCrypto.randomUUID()),
          createdBy: "user",
          creationSource: "web",
          sourceThreadId: sourceId,
          targetThreadId: forkId,
          sourcePoint: { type: "run", runId: sourceRunId },
          title: `${name} fork ${sibling}`,
        });
        yield* send(forkId, `Reply with exactly: fork ${sibling} ok. Do not use tools.`);
        const fork = yield* settle(forkId, 1);
        log(`[${name}] fork ${sibling} runs=${fork.runs.map((run) => run.status).join(",")}`);
        forks.push(fork);
      }
      // Merge one fork at a time; each needs a source turn to consume it before
      // the next. These source turns also continue the source after the move.
      const merges: Array<{ fork: ThreadId; outcome: string; sourceRun: string }> = [];
      let continued = source;
      for (const [index, fork] of forks.entries()) {
        const outcome = yield* client["orchestration.dispatchCommand"]({
          type: "thread.merge_back",
          commandId: CommandId.make(NodeCrypto.randomUUID()),
          createdBy: "user",
          creationSource: "web",
          sourceThreadId: fork.thread.id,
          targetThreadId: sourceId,
          sourcePoint:
            fork.runs.length === 0
              ? { type: "latest_stable" }
              : { type: "run", runId: lastRunId(fork) },
        }).pipe(
          Effect.as("accepted"),
          Effect.catch((error) => Effect.succeed(`rejected: ${String(error)}`)),
        );
        yield* send(sourceId, `Reply with exactly: source turn ${index + 2} ok. Do not use tools.`);
        continued = yield* settle(sourceId, index + 2);
        const sourceRun = continued.runs.at(-1)?.status ?? "none";
        merges.push({ fork: fork.thread.id, outcome, sourceRun });
        log(`[${name}] merge-back ${fork.thread.id}: ${outcome}; source turn ${sourceRun}`);
      }
      const finalForks = yield* Effect.forEach(forks, (fork) => projection(fork.thread.id));
      save(`${name}-source`, continued);
      finalForks.forEach((fork, index) => save(`${name}-fork-${index === 0 ? "a" : "b"}`, fork));
      return {
        name,
        dirA,
        dirB,
        source: summarize("source", continued),
        forks: finalForks.map((fork, index) => summarize(`fork-${index === 0 ? "a" : "b"}`, fork)),
        merges,
      };
    });

    return [yield* scenario("control"), yield* scenario("moved")];
  }).pipe(Effect.scoped, Effect.provide(layerProtocol));

  const scenarios = await Effect.runPromise(program);
  const projectsDir = NodePath.join(claudeHome, "projects");
  const transcripts = NodeFS.existsSync(projectsDir)
    ? NodeFS.readdirSync(projectsDir).map((slug) => ({
        slug,
        sessions: NodeFS.readdirSync(NodePath.join(projectsDir, slug)).filter((file) =>
          file.endsWith(".jsonl"),
        ),
      }))
    : [];
  const summary = { revision, model: values.model, claudeHome, scenarios, transcripts };
  NodeFS.writeFileSync(NodePath.join(evidence, "summary.json"), JSON.stringify(summary, null, 2));
  log(JSON.stringify(summary, null, 2));
} finally {
  stopServer();
}
