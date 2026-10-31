// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - the eval owns a server subprocess and a scratch workspace.
/**
 * An isolated T3 server for one device run. Its only provider is `evalbot`, an Fx instance
 * backed by `fake-fx.ts`, so every reply is scripted. State lives under the run's `--out`.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  CommandId,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  MessageId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  OrchestrationV2ShellSnapshot,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WsRpcGroup,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "../..");
export const EVAL_INSTANCE = ProviderInstanceId.make("evalbot");
export const EVAL_MODEL = "eval/scripted";

export const uuid = Effect.flatMap(Crypto.Crypto, (crypto) => crypto.randomUUIDv4());

export class EnvironmentError extends Schema.TaggedError<EnvironmentError>()("EnvironmentError", {
  message: Schema.String,
}) {}

export const freePort = () =>
  Effect.callback<number>((resume) => {
    const server = NodeNet.createServer();
    server.listen(0, () => {
      const address = server.address();
      server.close(() =>
        resume(Effect.succeed(typeof address === "object" && address ? address.port : 0)),
      );
    });
  });

const waitForPort = Effect.fn("environment.waitForPort")(function* (port: number) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const open = yield* Effect.callback<boolean>((resume) => {
      const socket = NodeNet.connect(port, "127.0.0.1");
      socket.once("connect", () => (socket.destroy(), resume(Effect.succeed(true))));
      socket.once("error", () => resume(Effect.succeed(false)));
    });
    if (open) return;
    yield* Effect.sleep("500 millis");
  }
  return yield* new EnvironmentError({ message: `The server never listened on ${port}.` });
});

/** Runs a server CLI command and returns both output streams. */
const runCli = (args: ReadonlyArray<string>) =>
  Effect.try({
    try: () => {
      const result = NodeChildProcess.spawnSync("node", ["apps/server/src/bin.ts", ...args], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      if (result.status !== 0) throw new Error(result.stderr);
      return { stdout: result.stdout, stderr: result.stderr };
    },
    catch: (cause) =>
      new EnvironmentError({ message: `bin.ts ${args.join(" ")} failed: ${cause}` }),
  });

function writeScratch(baseDir: string) {
  const workspace = NodePath.join(baseDir, "workspace/acme-app");
  const control = NodePath.join(baseDir, "control");
  NodeFS.mkdirSync(NodePath.join(baseDir, "userdata"), { recursive: true });
  NodeFS.mkdirSync(control, { recursive: true });
  NodeFS.mkdirSync(workspace, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(workspace, "README.md"), "# acme app\n");
  // The / menu's pickable row; without it, fx finds only skills in folders above `--out`.
  const skill = NodePath.join(workspace, ".fx/skills/eval-notes");
  NodeFS.mkdirSync(skill, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(skill, "SKILL.md"),
    "---\nname: eval-notes\ndescription: Takes notes for the eval.\n---\nTake notes.\n",
  );
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", ["-C", workspace, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=eval", "-c", "user.email=eval@example.com", "commit", "-qm", "init");
  const launcher = NodePath.join(baseDir, "fx");
  NodeFS.writeFileSync(
    launcher,
    `#!/bin/sh\nexec node ${JSON.stringify(NodePath.join(import.meta.dirname, "fake-fx.ts"))} "$@"\n`,
    { mode: 0o755 },
  );
  NodeFS.writeFileSync(
    NodePath.join(baseDir, "userdata/settings.json"),
    JSON.stringify({
      providerInstances: {
        [EVAL_INSTANCE]: {
          driver: "fx",
          displayName: "Eval Bot",
          environment: [{ name: "T3_EVAL_FX_CONTROL_DIR", value: control }],
          config: { enabled: true, binaryPath: launcher },
        },
      },
    }),
  );
  return { workspace, control };
}

/** Starts the server in the caller's scope; the scope's end stops it. */
export const startEnvironment = Effect.fn("environment.start")(function* (input: {
  readonly baseDir: string;
  /** Origin the device uses to reach this machine, without a port. */
  readonly deviceHost: string;
}) {
  NodeFS.rmSync(input.baseDir, { recursive: true, force: true });
  const { workspace, control } = writeScratch(input.baseDir);
  const home = NodePath.join(input.baseDir, "home");
  NodeFS.mkdirSync(home, { recursive: true });
  const port = yield* freePort();
  const log = NodeFS.openSync(NodePath.join(input.baseDir, "server.log"), "w");
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      NodeChildProcess.spawn(
        "node",
        [
          "apps/server/src/bin.ts",
          "serve",
          "--host",
          "0.0.0.0",
          "--port",
          String(port),
          "--base-dir",
          input.baseDir,
          "--no-browser",
          "--log-level",
          "warn",
          workspace,
        ],
        // A scratch HOME keeps the user's own skills and config out of the app under test.
        { cwd: REPO_ROOT, stdio: ["ignore", log, log], env: { ...process.env, HOME: home } },
      ),
    ),
    (child) => Effect.sync(() => child.kill("SIGTERM")),
  );
  yield* waitForPort(port);
  const origin = `http://127.0.0.1:${port}`;
  const issued = yield* runCli([
    "auth",
    "session",
    "issue",
    "--base-dir",
    input.baseDir,
    "--token-only",
  ]);
  // The token is the last line of stdout; stderr is only a fallback.
  const lastLine = (text: string) =>
    text
      .split("\n")
      .filter((line) => line.trim())
      .at(-1)
      ?.trim();
  const token = lastLine(issued.stdout) ?? lastLine(issued.stderr) ?? "";
  const http = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest((request) =>
      request.pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeader(
          ORCHESTRATION_PROTOCOL_HEADER,
          String(ORCHESTRATION_PROTOCOL_VERSION),
        ),
      ),
    ),
    HttpClient.filterStatusOk,
  );
  const descriptor = yield* http
    .get(`${origin}/.well-known/t3/environment`)
    .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)));
  const shell = () =>
    http
      .get(`${origin}/api/orchestration/shell`)
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(OrchestrationV2ShellSnapshot)));
  const createProject = Effect.fn("environment.createProject")(function* (
    title: string,
    workspaceRoot: string,
  ) {
    const projectId = ProjectId.make(yield* uuid);
    yield* http.execute(
      HttpClientRequest.post(`${origin}/api/projects/mutate`).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          type: "project.create",
          commandId: yield* uuid,
          projectId,
          title,
          workspaceRoot,
        }),
      ),
    );
    return projectId;
  });
  const projectId = yield* createProject("acme-app", workspace);
  const ticket = yield* http
    .execute(HttpClientRequest.post(`${origin}/api/auth/websocket-ticket`))
    .pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Struct({ ticket: Schema.String }))),
    );
  // Built into the caller's scope: `Effect.provide` would close the socket once `make` returns.
  const protocol = yield* Layer.build(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide(
        Socket.layerWebSocket(
          `${origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket.ticket)}`,
        ),
      ),
      Layer.provide(RpcSerialization.layerJson),
      Layer.provide(NodeSocket.layerWebSocketConstructorWS),
    ),
  );
  const client = yield* RpcClient.make(WsRpcGroup).pipe(Effect.provideContext(protocol));
  const environmentId = EnvironmentId.make(descriptor.environmentId);

  const command = Effect.map(uuid, CommandId.make);
  const projection = (threadId: ThreadId) =>
    client["orchestration.getThreadProjection"]({ threadId });

  const create = Effect.fn("environment.create")(function* (
    title: string,
    prompt?: string,
    project: ProjectId = projectId,
  ) {
    const threadId = ThreadId.make(yield* uuid);
    yield* client["orchestration.launchThread"]({
      commandId: yield* command,
      threadId,
      projectId: project,
      title,
      modelSelection: { instanceId: EVAL_INSTANCE, model: EVAL_MODEL },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      ...(prompt === undefined ? {} : { initialMessage: { text: prompt, attachments: [] } }),
    });
    return threadId;
  });

  /** Starts a thread whose first reply follows `prompt`'s `[[eval:…]]` script. */
  const launch = (title: string, prompt: string) => create(title, prompt);

  const until = Effect.fn("environment.until")(function* <A>(
    description: string,
    threadId: ThreadId,
    pick: (value: OrchestrationV2ThreadProjection) => A | undefined,
  ) {
    for (let attempt = 0; attempt < 150; attempt++) {
      const found = pick(yield* projection(threadId));
      if (found !== undefined) return found;
      yield* Effect.sleep("200 millis");
    }
    return yield* new EnvironmentError({ message: `Thread ${threadId} never had ${description}.` });
  });

  const send = Effect.fn("environment.send")(function* (threadId: ThreadId, text: string) {
    yield* client["orchestration.dispatchCommand"]({
      type: "message.dispatch",
      commandId: yield* command,
      threadId,
      messageId: MessageId.make(yield* uuid),
      text,
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "server",
    });
  });

  const isSettled = (value: OrchestrationV2ThreadProjection) =>
    value.runs.length > 0 &&
    value.runs.every((run) =>
      ["completed", "failed", "interrupted", "cancelled"].includes(run.status),
    );

  /** Waits until every run of the thread has ended. */
  const settled = Effect.fn("environment.settled")(function* (threadId: ThreadId) {
    for (let attempt = 0; attempt < 600; attempt++) {
      const value = yield* projection(threadId);
      if (isSettled(value)) return value;
      yield* Effect.sleep("200 millis");
    }
    return yield* new EnvironmentError({ message: `Thread ${threadId} never settled.` });
  });

  /** A settled thread of `turns` request and reply pairs, for scroll and jank cases. */
  const longThread = Effect.fn("environment.longThread")(function* (title: string, turns: number) {
    const threadId = yield* launch(title, "Summarize the module. [[eval:stream:400:0]]");
    yield* settled(threadId);
    for (let turn = 1; turn < turns; turn++) {
      const text = `Next part ${turn}. [[eval:stream:${turn % 3 === 0 ? 900 : 300}:0]]`;
      yield* send(threadId, text);
      // The message and its run land in one command, so once it shows, `settled` sees the run.
      yield* until("its next message", threadId, (value) =>
        value.messages.some((message) => message.text === text) ? true : undefined,
      );
      yield* settled(threadId);
    }
    return threadId;
  });

  return {
    /** An empty thread in its own project; `lock` then disables `evalbot` there, so sends are rejected. */
    launchLockable: Effect.fn("environment.launchLockable")(function* (title: string) {
      const root = NodePath.join(input.baseDir, `workspace/locked-${(yield* uuid).slice(0, 6)}`);
      NodeFS.mkdirSync(root, { recursive: true });
      const project = yield* createProject("locked", root);
      const threadId = yield* create(title, undefined, project);
      const lock = client["server.updateSettings"]({
        patch: {
          projectSettingsOverrides: {
            [project]: { providerInstances: { [EVAL_INSTANCE]: { enabled: false } } },
          },
        },
      });
      return { threadId, lock };
    }),
    /** Archives every thread but `keep`, so earlier samples' rows never crowd Home. */
    archiveAllExcept: Effect.fn("environment.archiveAllExcept")(function* (keep: ThreadId) {
      for (const thread of (yield* shell()).threads) {
        if (thread.id === keep) continue;
        yield* client["orchestration.dispatchCommand"]({
          type: "thread.archive",
          commandId: yield* command,
          threadId: thread.id,
        });
      }
    }),
    /** Stops every unfinished run, so one sample's held turns never leak into the next. */
    interruptAll: Effect.fn("environment.interruptAll")(function* () {
      const threads = (yield* shell()).threads;
      for (const thread of threads)
        for (const run of (yield* projection(thread.id)).runs) {
          if (["completed", "failed", "interrupted", "cancelled"].includes(run.status)) continue;
          yield* client["orchestration.dispatchCommand"]({
            type: "run.interrupt",
            commandId: yield* command,
            threadId: thread.id,
            runId: run.id,
          });
        }
      for (const thread of threads)
        if ((yield* projection(thread.id)).runs.length) yield* settled(thread.id);
    }),
    waitForPendingInput: (threadId: ThreadId) =>
      until("a pending question", threadId, (value) =>
        value.runtimeRequests.find((request) => request.status === "pending"),
      ),
    waitForSubagents: (threadId: ThreadId) =>
      until("running subagents", threadId, (value) =>
        value.subagents.length >= 2 ? value.subagents : undefined,
      ),
    origin,
    environmentId,
    archive: (threadId: ThreadId) =>
      command.pipe(
        Effect.flatMap((commandId) =>
          client["orchestration.dispatchCommand"]({ type: "thread.archive", commandId, threadId }),
        ),
        Effect.asVoid,
      ),
    unpin: (threadId: ThreadId) =>
      command.pipe(
        Effect.flatMap((commandId) =>
          client["orchestration.dispatchCommand"]({ type: "thread.unpin", commandId, threadId }),
        ),
        Effect.asVoid,
      ),
    projection,
    launch,
    send,
    settled,
    longThread,
    shell,
    release: (key: string) =>
      Effect.sync(() => NodeFS.writeFileSync(NodePath.join(control, `release-${key}`), "")),
    pairingUrl: () =>
      runCli([
        "auth",
        "pairing",
        "create",
        "--base-dir",
        input.baseDir,
        "--base-url",
        `http://${input.deviceHost}:${port}`,
        "--ttl",
        "15m",
        "--label",
        "mobile-behavior-eval",
      ]).pipe(
        Effect.flatMap((out) => {
          const url = /Pair URL:\s*(\S+)/.exec(`${out.stdout}\n${out.stderr}`)?.[1];
          return url
            ? Effect.succeed(url)
            : Effect.fail(new EnvironmentError({ message: "No pairing URL in CLI output." }));
        }),
      ),
  };
}, Effect.provide(FetchHttpClient.layer));

export type EvalEnvironment = Effect.Success<ReturnType<typeof startEnvironment>>;
