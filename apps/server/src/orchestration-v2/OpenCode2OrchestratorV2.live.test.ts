/**
 * Runs OpenCode 2 through the whole orchestrator with the real driver: the
 * driver probes the binary, spawns `opencode serve`, and routes to the 2.x
 * adapter. One thread reads a file, runs a shell command, and stops another;
 * a Supervised thread approves one command, declines another, and answers a
 * question; a plan-mode thread may write only its plan; and a thread steers,
 * queues, forks and rolls back.
 *
 *   OPENCODE2_BIN=/path/to/opencode OPENCODE2_LIVE_ROOT=/scratch/dir \
 *     vp test run src/orchestration-v2/OpenCode2OrchestratorV2.live.test.ts
 *
 * The server runs with isolated HOME and XDG directories on the free
 * `opencode/big-pickle` model; `OPENCODE2_MODEL` picks another (its provider's
 * key comes from the test's environment, which the spawned server inherits).
 * A second run covers plan mode, a workspace command and skill, and `/compact`;
 * a third a generated title, T3's MCP server (`OPENCODE2_MCP_URL` names a
 * stand-in one) and a turn cut off by a killed server. Each step waits up to
 * `OPENCODE2_STEP_WAIT` seconds (120 by default).
 */
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqlite from "node:sqlite";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { describe } from "vite-plus/test";

import * as ResetCreditCoordinator from "../provider/Layers/resetCreditCoordinator.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "../background/HostPowerMonitor.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as AntigravityInstallation from "../provider/AntigravityInstallation.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import { ProviderInstanceRegistryHydrationLive } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import * as ProviderEventLoggers from "../provider/Layers/ProviderEventLoggers.ts";
import * as OpenCode2Client from "../provider/opencode2/OpenCode2Client.ts";
import * as OpenCodeRuntime from "../provider/opencodeRuntime.ts";
import * as ProviderProcessLedger from "../provider/ProviderProcessLedger.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import { worktreeRepairDependenciesTestLayer } from "./ProviderTurnStartService.testkit.ts";
import { OrchestrationV2LayerLive } from "./runtimeLayer.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProviderContinuationRequests from "./ProviderContinuationRequests.ts";
import * as ProviderContinuationService from "./ProviderContinuationService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";

const binaryPath = process.env.OPENCODE2_BIN;
const ROOT = process.env.OPENCODE2_LIVE_ROOT ?? "";
const INSTANCE = ProviderInstanceId.make("opencode");
const MODEL: ModelSelection = {
  instanceId: INSTANCE,
  model: process.env.OPENCODE2_MODEL ?? "opencode/big-pickle",
};
// The free model the thread switches to mid-conversation.
const SWITCHED_MODEL = "opencode/mimo-v2.6-flash-free";

/** The OpenCode servers the driver spawned, newest last, so a test can kill one by its own PID. */
const spawnedPids: Array<number> = [];
const spawnedServers = Layer.succeed(
  ProviderProcessLedger.ProviderProcessLedger,
  ProviderProcessLedger.ProviderProcessLedger.of({
    track: ({ pid }) =>
      Effect.sync(() => {
        spawnedPids.push(pid);
        return Effect.void;
      }),
  }),
);

/**
 * Credentials for T3's MCP server. `OPENCODE2_MCP_URL` points them at a stand-in
 * MCP server the run can see called; without it they point nowhere, as in replay.
 */
const MCP_URL = process.env.OPENCODE2_MCP_URL ?? "http://127.0.0.1/mcp";
const mcpRegistryLayer = Layer.succeed(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.McpSessionRegistry.of({
    issue: ({ threadId, providerInstanceId }) =>
      Effect.succeed({
        config: {
          environmentId: EnvironmentId.make("environment:opencode2-live"),
          threadId,
          providerSessionId: `mcp-live:${threadId}`,
          providerInstanceId,
          endpoint: MCP_URL,
          authorizationHeader: `Bearer mcp-live:${threadId}`,
          browserToolsAvailable: false,
        },
      }),
    resolve: () => Effect.succeed(undefined),
    touch: () => Effect.void,
    revokeProviderSession: () => Effect.void,
    revokeThread: () => Effect.void,
    revokeAll: Effect.void,
  }),
);

const PlatformTestLayer = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);
const serverConfigLayer = ServerConfig.layerTest(`${ROOT}/work`, { prefix: "t3-opencode2-live-" });
const vcsDriverRegistryLayer = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(serverConfigLayer),
  Layer.provide(PlatformTestLayer),
);
// Isolated OpenCode state: the server never touches the developer's own data.
const serverSettingsLayer = ServerSettings.layerTest({
  providerInstances: {
    [INSTANCE]: {
      driver: ProviderDriverKind.make("opencode"),
      enabled: true,
      environment: [
        { name: "HOME", value: ROOT },
        { name: "XDG_CONFIG_HOME", value: `${ROOT}/config` },
        { name: "XDG_DATA_HOME", value: `${ROOT}/data` },
        { name: "XDG_STATE_HOME", value: `${ROOT}/state` },
        { name: "XDG_CACHE_HOME", value: `${ROOT}/cache` },
      ],
      // `OPENCODE2_SERVER_URL` connects to an external server instead of spawning one.
      config: {
        enabled: true,
        binaryPath,
        ...(process.env.OPENCODE2_SERVER_URL === undefined
          ? {}
          : {
              serverUrl: process.env.OPENCODE2_SERVER_URL,
              serverPassword: process.env.OPENCODE2_SERVER_PASSWORD ?? "",
            }),
      },
    },
  },
});
const backgroundPolicyLayer = BackgroundPolicy.layer.pipe(
  Layer.provide(Layer.effect(HostPowerMonitor.HostPowerMonitor, HostPowerMonitor.make())),
  Layer.provide(serverSettingsLayer),
);
const providerInstanceRegistryLayer = ProviderInstanceRegistryHydrationLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      serverConfigLayer.pipe(Layer.provide(PlatformTestLayer)),
      serverSettingsLayer,
      ServerSecretStore.layer.pipe(
        Layer.provide(serverConfigLayer),
        Layer.provide(PlatformTestLayer),
      ),
      NodeServices.layer,
      FetchHttpClient.layer,
      OpenCodeRuntime.OpenCodeRuntimeLive.pipe(
        Layer.provideMerge(spawnedServers),
        Layer.provide(PlatformTestLayer),
      ),
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
      ModelManifest.layerTest,
      AntigravityInstallation.AntigravityInstallation.layer.pipe(
        Layer.provide(serverConfigLayer.pipe(Layer.provide(PlatformTestLayer))),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(PlatformTestLayer),
      ),
      // The Codex driver now resolves managed ChatGPT installs; these runs never launch Codex.
      Layer.mock(CodexInstallation.CodexInstallation)({
        managedDirectory: "unused-managed-installation",
      }),
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(
          EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
        ),
      }),
    ),
  ),
);
const orchestrationLayer = OrchestrationV2LayerLive.pipe(
  Layer.provide(worktreeRepairDependenciesTestLayer),
  Layer.provide(mcpRegistryLayer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(CheckpointStore.layer.pipe(Layer.provide(vcsDriverRegistryLayer))),
  Layer.provide(serverConfigLayer),
  Layer.provide(serverSettingsLayer),
  // Merged, not only provided: the test reads the same instance the orchestrator uses.
  Layer.provideMerge(providerInstanceRegistryLayer),
  Layer.provide(ResetCreditCoordinator.layer),
  Layer.provide(backgroundPolicyLayer),
  Layer.provide(PlatformTestLayer),
);

// Starts the continuation run a provider wake asks for, as the production layer does.
const continuationWorkerLayer = ProviderContinuationService.workerLive.pipe(
  Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        return Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch: orchestrator.dispatch,
          getThreadRecords: orchestrator.getThreadRecords,
          getThreadProjection: orchestrator.getThreadProjection,
        });
      }),
    ),
  ),
  Layer.provide(IdAllocator.layer),
  Layer.provide(ProviderContinuationRequests.layer),
);
const liveLayer = continuationWorkerLayer.pipe(Layer.provideMerge(orchestrationLayer));

// How long one step may take, in seconds. A free model sometimes takes minutes
// before its first tool call; `OPENCODE2_STEP_WAIT` raises it for such runs.
const STEP_WAIT_SECONDS = Number(process.env.OPENCODE2_STEP_WAIT ?? "120");

const settled = (projection: OrchestrationV2ThreadProjection) =>
  projection.runs.length > 0 &&
  projection.runs.every(
    (run) => !["queued", "starting", "running", "waiting"].includes(run.status),
  );

const waitFor = Effect.fn("OpenCode2Live.waitFor")(function* (
  threadId: ThreadId,
  done: (projection: OrchestrationV2ThreadProjection) => boolean,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  for (let attempt = 0; attempt < STEP_WAIT_SECONDS * 2; attempt += 1) {
    const projection = yield* orchestrator.getThreadProjection(threadId);
    if (done(projection)) return projection;
    yield* Effect.sleep("500 millis");
  }
  const last = yield* orchestrator.getThreadProjection(threadId);
  const items = last.turnItems.map((item) =>
    item.type === "error" ? `error:${item.failure.message}` : `${item.type}:${item.status}`,
  );
  return yield* Effect.die(
    new Error(
      `Timed out waiting on OpenCode 2 thread ${threadId}: runs ${last.runs.map((run) => run.status).join(",")}; items ${items.join(",")}`,
    ),
  );
});

const send = Effect.fn("OpenCode2Live.send")(function* (
  threadId: ThreadId,
  key: string,
  text: string,
  modelSelection: ModelSelection = MODEL,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make(`command:opencode2-live:${key}`),
    threadId,
    messageId: MessageId.make(`message:opencode2-live:${key}`),
    text,
    attachments: [],
    modelSelection,
    dispatchMode: { type: "start_immediately" },
  });
});

const AssistantModel = Schema.fromJsonString(
  Schema.Struct({
    model: Schema.Struct({ providerID: Schema.String, id: Schema.String }),
    agent: Schema.optional(Schema.String),
  }),
);
const decodeAssistantModel = Schema.decodeUnknownSync(AssistantModel);

/**
 * The `provider/model` of each assistant message in a native session, oldest
 * first, from the spawned server's own database under the isolated XDG root.
 */
const assistantModels = (nativeSessionId: string) =>
  Effect.sync(() => {
    const db = new NodeSqlite.DatabaseSync(`${ROOT}/data/opencode/opencode.db`, { readOnly: true });
    try {
      return db
        .prepare(
          "SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq",
        )
        .all(nativeSessionId)
        .map((row) => decodeAssistantModel(row.data).model)
        .map((model) => `${model.providerID}/${model.id}`);
    } finally {
      db.close();
    }
  });

/** The agent that wrote each assistant message in a native session, oldest first. */
const assistantAgents = (nativeSessionId: string) =>
  Effect.sync(() => {
    const db = new NodeSqlite.DatabaseSync(`${ROOT}/data/opencode/opencode.db`, { readOnly: true });
    try {
      return db
        .prepare(
          "SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq",
        )
        .all(nativeSessionId)
        .map((row) => decodeAssistantModel(row.data).agent);
    } finally {
      db.close();
    }
  });

describe.runIf(binaryPath !== undefined && ROOT !== "")("OpenCode 2 live orchestrator", () => {
  it.live(
    "runs a tool turn and stops a running shell command through the real driver",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.writeFileString(path.join(ROOT, "work", "hello.txt"), "hello from t3 live\n");
        yield* EffectWorker.runDaemonWithOptions({ concurrency: 2 }).pipe(Effect.forkScoped);

        // A status check starts a fresh server, which lists no models for its
        // first few hundred milliseconds; the picker must still get them.
        const instance =
          yield* (yield* ProviderInstanceRegistry.ProviderInstanceRegistry).getInstance(INSTANCE);
        assert.isDefined(instance);
        const status = yield* instance!.snapshot.refresh;
        assert.equal(status.status, "ready");
        assert.include(
          status.models.map((model) => model.slug),
          "opencode/big-pickle",
        );
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make("thread:opencode2-live");
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:opencode2-live:create"),
          threadId,
          projectId: ProjectId.make("project:opencode2-live"),
          title: "OpenCode 2 live",
          modelSelection: MODEL,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: `${ROOT}/work`,
        });

        yield* send(
          threadId,
          "tools",
          // The shell call outlasts the spawned server's 30 second idle timeout.
          "Use the read tool to read hello.txt, then run the shell command `sleep 35 && echo TOOL_OK` with the shell tool in the foreground (not in the background) and wait for it to finish, then reply DONE.",
        );
        const first = yield* waitFor(threadId, settled);
        assert.deepEqual(
          first.runs.map((run) => run.status),
          ["completed"],
        );
        const shell = first.turnItems.find((item) => item.type === "command_execution");
        assert.deepInclude(shell, { status: "completed", exitCode: 0 });
        assert.include(shell?.type === "command_execution" ? shell.output : "", "TOOL_OK");
        assert.isDefined(
          first.turnItems.find((item) => item.type === "dynamic_tool" && item.toolName === "read"),
        );
        assert.isAbove(first.providerTurns[0]?.tokenUsage?.maxTokens ?? 0, 0);

        yield* send(
          threadId,
          "stop",
          "Run the shell command `sleep 60 && echo LATE` with the shell tool in the foreground (not in the background) and wait for it to finish, then reply DONE.",
        );
        const running = yield* waitFor(threadId, (projection) =>
          projection.turnItems.some(
            (item) =>
              item.type === "command_execution" &&
              item.status === "running" &&
              item.input.includes("sleep 60"),
          ),
        );
        const secondRun = running.runs.at(-1)!;
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("command:opencode2-live:interrupt"),
          threadId,
          runId: secondRun.id,
        });
        const stopped = yield* waitFor(threadId, settled);
        assert.deepEqual(
          stopped.runs.map((run) => run.status),
          ["completed", "interrupted"],
        );
        const sleep = stopped.turnItems.find(
          (item) => item.type === "command_execution" && item.input.includes("sleep 60"),
        );
        assert.equal(sleep?.status, "interrupted");

        // A model change applies to the same native session on the next turn.
        const switched: ModelSelection = { instanceId: INSTANCE, model: SWITCHED_MODEL };
        yield* send(threadId, "switch", "Reply with exactly: SWITCHED", switched);
        const third = yield* waitFor(
          threadId,
          (projection) => projection.runs.length === 3 && settled(projection),
        );
        assert.equal(third.runs.at(-1)?.status, "completed");
        const sessionId = third.providerThreads[0]?.nativeThreadRef?.nativeId;
        assert.isDefined(sessionId);
        const models = yield* assistantModels(sessionId!);
        assert.equal(models.at(-1), SWITCHED_MODEL);
        assert.notEqual(models[0], SWITCHED_MODEL);
      }).pipe(Effect.provide(Layer.merge(liveLayer, NodeServices.layer)), Effect.scoped),
    360_000,
  );

  it.live(
    "asks before each shell command in Supervised, runs the approved one, skips the declined one, and answers a question",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* EffectWorker.runDaemonWithOptions({ concurrency: 2 }).pipe(Effect.forkScoped);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make("thread:opencode2-live-supervised");
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:opencode2-live:supervised-create"),
          threadId,
          projectId: ProjectId.make("project:opencode2-live"),
          title: "OpenCode 2 live supervised",
          modelSelection: MODEL,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: `${ROOT}/work`,
        });
        const pendingAsk = (projection: OrchestrationV2ThreadProjection) =>
          projection.runtimeRequests.find((request) => request.status === "pending");
        const answer = (
          key: string,
          request: OrchestrationV2ThreadProjection["runtimeRequests"][number],
          response: { decision: "accept" | "decline" } | { answers: Record<string, string> },
        ) =>
          orchestrator.dispatch({
            type: "runtime-request.respond",
            commandId: CommandId.make(`command:opencode2-live:${key}`),
            threadId,
            requestId: request.id,
            ...response,
          });

        yield* send(
          threadId,
          "approve",
          "Run the shell command `touch approved.txt` with the shell tool, then reply DONE.",
        );
        const asked = yield* waitFor(
          threadId,
          (projection) => pendingAsk(projection) !== undefined,
        );
        assert.equal(pendingAsk(asked)?.kind, "command");
        yield* answer("approve-answer", pendingAsk(asked)!, { decision: "accept" });
        const approved = yield* waitFor(threadId, settled);
        assert.equal(approved.runs.at(-1)?.status, "completed");
        assert.isTrue(yield* fs.exists(path.join(ROOT, "work", "approved.txt")));

        yield* send(
          threadId,
          "decline",
          "Run the shell command `touch declined.txt` with the shell tool, then reply DONE.",
        );
        const second = yield* waitFor(
          threadId,
          (projection) => projection.runs.length === 2 && pendingAsk(projection) !== undefined,
        );
        yield* answer("decline-answer", pendingAsk(second)!, { decision: "decline" });
        // The model may try again; every retry is declined too.
        let declined = yield* waitFor(
          threadId,
          (projection) =>
            (projection.runs.length === 2 && settled(projection)) ||
            pendingAsk(projection) !== undefined,
        );
        for (let retry = 0; pendingAsk(declined) !== undefined && retry < 3; retry += 1) {
          yield* answer(`decline-retry-${retry}`, pendingAsk(declined)!, { decision: "decline" });
          declined = yield* waitFor(
            threadId,
            (projection) =>
              (projection.runs.length === 2 && settled(projection)) ||
              pendingAsk(projection) !== undefined,
          );
        }
        assert.equal(declined.runs.at(-1)?.status, "completed");
        assert.isFalse(yield* fs.exists(path.join(ROOT, "work", "declined.txt")));

        yield* send(
          threadId,
          "question",
          "Before doing anything, use the question tool to ask me which color I prefer, offering the options red and blue. After I answer, reply with only the chosen color.",
        );
        const questioned = yield* waitFor(
          threadId,
          (projection) => projection.runs.length === 3 && pendingAsk(projection) !== undefined,
        );
        const question = pendingAsk(questioned)!;
        assert.equal(question.kind, "user_input");
        const form = questioned.turnItems.find(
          (item) => item.type === "user_input_request" && item.requestId === question.id,
        );
        const firstQuestion = form?.type === "user_input_request" ? form.questions[0] : undefined;
        assert.isDefined(firstQuestion);
        yield* answer("question-answer", question, { answers: { [firstQuestion!.id]: "Blue" } });
        const answered = yield* waitFor(
          threadId,
          (projection) => projection.runs.length === 3 && settled(projection),
        );
        assert.equal(answered.runs.at(-1)?.status, "completed");
        const reply = answered.messages.findLast((message) => message.role === "assistant");
        assert.match(reply?.text ?? "", /blue/i);
      }).pipe(Effect.provide(Layer.merge(liveLayer, NodeServices.layer)), Effect.scoped),
    600_000,
  );

  it.live(
    "lets plan mode write only the plan agent's plan directory under Full access",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* EffectWorker.runDaemonWithOptions({ concurrency: 2 }).pipe(Effect.forkScoped);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make("thread:opencode2-live-plan");
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:opencode2-live:plan-create"),
          threadId,
          projectId: ProjectId.make("project:opencode2-live"),
          title: "OpenCode 2 live plan",
          modelSelection: MODEL,
          runtimeMode: "full-access",
          interactionMode: "plan",
          branch: null,
          worktreePath: `${ROOT}/work`,
        });
        // The plan agent's directory: `$HOME/.opencode/plan` under the isolated HOME.
        const planDir = path.join(ROOT, ".opencode", "plan");
        // The plan agent runs under the session's plan rules: the edit deny
        // holds for the workspace, and the plan directory stays writable.
        yield* send(
          threadId,
          "plan",
          `This is a permission test. Do exactly these two tool calls and nothing else: 1) use the write tool to create ${planDir}/probe-plan.md containing PLAN_OK; 2) use the write tool to create plan_write_probe.txt in the current directory containing NO. Then reply with which calls succeeded.`,
        );
        const planned = yield* waitFor(threadId, settled);
        assert.equal(planned.runs.at(-1)?.status, "completed");
        assert.isFalse(yield* fs.exists(path.join(ROOT, "work", "plan_write_probe.txt")));
        assert.isTrue(yield* fs.exists(path.join(planDir, "probe-plan.md")));
      }).pipe(Effect.provide(Layer.merge(liveLayer, NodeServices.layer)), Effect.scoped),
    360_000,
  );

  it.live(
    "runs subagents, wakes the thread for a background one, and stops one still running",
    () =>
      Effect.gen(function* () {
        yield* EffectWorker.runDaemonWithOptions({ concurrency: 2 }).pipe(Effect.forkScoped);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        // One thread per case: a model that just answered one prompt may repeat it.
        const thread = Effect.fn("OpenCode2Live.subagentThread")(function* (key: string) {
          const threadId = ThreadId.make(`thread:opencode2-live-subagents-${key}`);
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`command:opencode2-live:subagents-${key}-create`),
            threadId,
            projectId: ProjectId.make("project:opencode2-live"),
            title: `OpenCode 2 live subagents ${key}`,
            modelSelection: MODEL,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: `${ROOT}/work`,
          });
          return threadId;
        });
        const childOf = (projection: OrchestrationV2ThreadProjection) =>
          Effect.gen(function* () {
            const childThreadId = projection.subagents[0]?.childThreadId;
            assert.isDefined(childThreadId ?? undefined);
            return yield* orchestrator.getThreadProjection(childThreadId!);
          });

        // Foreground: the turn waits for the child thread's answer.
        const fgThread = yield* thread("fg");
        yield* send(
          fgThread,
          "subagents-fg",
          "Use the subagent tool (foreground, not background) to delegate to the general subagent with the prompt: 'Reply exactly FG_CHILD_OK.' Wait for it, then reply exactly FG_PARENT_OK.",
        );
        const foreground = yield* waitFor(fgThread, settled);
        assert.deepEqual(
          foreground.runs.map((run) => run.status),
          ["completed"],
        );
        assert.equal(foreground.subagents[0]?.status, "completed");
        const fgChild = yield* childOf(foreground);
        assert.isTrue(
          fgChild.turnItems.some(
            (item) => item.type === "assistant_message" && item.text.includes("FG_CHILD_OK"),
          ),
        );

        // Background: when the child ends after run 1, OpenCode wakes the parent
        // and T3 opens run 2 for that execution. A child that ends while run 1
        // still runs has its report delivered into run 1 instead, which then
        // answers it, and no continuation run opens. Either way the subagent
        // completes and nothing is left running.
        const bgThread = yield* thread("bg");
        yield* send(
          bgThread,
          "subagents-bg",
          "Use the subagent tool with background set to true to delegate to the general subagent with the prompt: 'Run the shell command `sleep 8` with the shell tool, then reply exactly BG_CHILD_OK.' As soon as it is launched, reply exactly BG_LAUNCHED and end your turn without waiting.",
        );
        const woke = yield* waitFor(
          bgThread,
          (projection) =>
            settled(projection) &&
            projection.subagents[0]?.status === "completed" &&
            !projection.turnItems.some(
              (item) => item.status === "running" || item.status === "waiting",
            ),
        );
        assert.isTrue(woke.runs.every((run) => run.status === "completed"));
        const answeredIn = woke.runs.at(-1)!;
        if (woke.runs.length === 2) {
          const wakeMessage = woke.messages.find(
            (message) => message.id === answeredIn.userMessageId,
          );
          assert.equal(
            `${wakeMessage?.createdBy}:${wakeMessage?.creationSource}`,
            "agent:provider",
          );
        } else {
          assert.lengthOf(woke.runs, 1);
        }
        assert.isTrue(
          woke.turnItems.some(
            (item) => item.runId === answeredIn.id && item.type === "assistant_message",
          ),
          "the parent's answer to the report lands in the run that took it",
        );

        // Stop while a background child runs: OpenCode keeps a background
        // child running past a parent Stop, so T3 stops it, and nothing wakes.
        const stopThread = yield* thread("stop");
        yield* send(
          stopThread,
          "subagents-stop",
          "Use the subagent tool with background set to true to delegate to the general subagent with the prompt: 'Run the shell command `sleep 60` with the shell tool, then reply exactly LATE.' As soon as it is launched, reply exactly STOP_LAUNCHED and end your turn without waiting.",
        );
        const launched = yield* waitFor(
          stopThread,
          (projection) =>
            projection.runs[0]?.status !== "running" &&
            projection.subagents[0]?.status === "running",
        );
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("command:opencode2-live:subagents-stop-interrupt"),
          threadId: stopThread,
          runId: launched.runs[0]!.id,
        });
        yield* waitFor(
          stopThread,
          (projection) =>
            settled(projection) &&
            projection.subagents[0] !== undefined &&
            projection.subagents[0].status !== "running",
        );
        // Still settled once OpenCode has reported the stopped child to its parent.
        yield* Effect.sleep("5 seconds");
        const final = yield* orchestrator.getThreadProjection(stopThread);
        assert.lengthOf(final.runs, 1);
        assert.equal(final.subagents[0]?.status, "interrupted");
        assert.isFalse(
          final.turnItems.some((item) => item.status === "running" || item.status === "waiting"),
        );
        const stoppedChild = yield* childOf(final);
        assert.isFalse(
          stoppedChild.turnItems.some((item) => item.status === "running"),
          "the stopped child shows nothing running",
        );
      }).pipe(Effect.provide(Layer.merge(liveLayer, NodeServices.layer)), Effect.scoped),
    480_000,
  );

  it.live(
    "steers a running turn, queues two messages, forks an earlier turn and rolls back a write",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* EffectWorker.runDaemonWithOptions({ concurrency: 2 }).pipe(Effect.forkScoped);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        // A worktree of its own, so rolling back restores files for this thread only.
        const work = path.join(ROOT, "inbox-work");
        yield* fs.makeDirectory(work, { recursive: true });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const git = (...args: ReadonlyArray<string>) =>
          spawner.exitCode(ChildProcess.make("git", ["-C", work, ...args]));
        yield* git("init", "-q");
        yield* git(
          "-c",
          "user.name=t3",
          "-c",
          "user.email=t3@example.com",
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          "init",
        );
        const threadId = ThreadId.make("thread:opencode2-live-inbox");
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:opencode2-live-inbox:create"),
          threadId,
          projectId: ProjectId.make("project:opencode2-live-inbox"),
          title: "OpenCode 2 live inbox",
          modelSelection: MODEL,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: work,
        });
        const dispatch = (
          key: string,
          text: string,
          dispatchMode: Extract<
            OrchestrationV2Command,
            { type: "message.dispatch" }
          >["dispatchMode"],
        ) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`command:opencode2-live-inbox:${key}`),
            threadId,
            messageId: MessageId.make(`message:opencode2-live-inbox:${key}`),
            text,
            attachments: [],
            modelSelection: MODEL,
            dispatchMode,
          });
        const assistantText = (projection: OrchestrationV2ThreadProjection, runId: string) =>
          projection.turnItems
            .flatMap((item) =>
              item.type === "assistant_message" && item.runId === runId ? [item.text] : [],
            )
            .join("\n");

        // 1. A turn that writes ALPHA, which the rollback keeps.
        yield* dispatch(
          "alpha",
          "Use the write tool to create reverted.txt containing exactly ALPHA, then reply DONE.",
          { type: "start_immediately" },
        );
        const first = yield* waitFor(threadId, settled);
        assert.equal(first.runs[0]?.status, "completed");
        assert.equal((yield* fs.readFileString(path.join(work, "reverted.txt"))).trim(), "ALPHA");

        // 2. A long shell turn: steered while it runs, with two messages queued behind it.
        yield* dispatch(
          "shell",
          "Run the shell command `sleep 15 && echo A` with the shell tool in the foreground (not in the background) and wait for it, then use the write tool to overwrite reverted.txt with exactly BETA, then reply DONE_A.",
          { type: "start_immediately" },
        );
        const running = yield* waitFor(threadId, (projection) =>
          projection.turnItems.some(
            (item) => item.type === "command_execution" && item.status === "running",
          ),
        );
        const shellRun = running.runs.at(-1)!;
        yield* dispatch("steer", "Also include the word STEERED in your final reply.", {
          type: "steer_active",
          targetRunId: shellRun.id,
        });
        yield* dispatch("queued-b", "Reply with exactly QUEUED_B.", { type: "queue_after_active" });
        yield* dispatch("queued-c", "Reply with exactly QUEUED_C.", { type: "queue_after_active" });
        const drained = yield* waitFor(
          threadId,
          (projection) => projection.runs.length === 4 && settled(projection),
        );
        const [, shell, queuedB, queuedC] = drained.runs;
        assert.deepEqual(
          drained.runs.map((run) => run.status),
          ["completed", "completed", "completed", "completed"],
        );
        // The steer joined the running turn: its answer is in that run, one provider turn each.
        assert.include(assistantText(drained, shell!.id), "STEERED");
        assert.include(assistantText(drained, queuedB!.id), "QUEUED_B");
        assert.include(assistantText(drained, queuedC!.id), "QUEUED_C");
        assert.lengthOf(drained.providerTurns, 4);
        // Steered natively: a steer user item in the shell run, no restart attempt.
        assert.deepEqual(
          drained.turnItems.flatMap((item) =>
            item.type === "user_message" && item.runId === shell!.id ? [item.inputIntent] : [],
          ),
          ["turn_start", "steer"],
        );
        assert.lengthOf(
          drained.attempts.filter((attempt) => attempt.runId === shell!.id),
          1,
        );
        assert.equal((yield* fs.readFileString(path.join(work, "reverted.txt"))).trim(), "BETA");

        // 3. Fork from the first turn: the fork only knows what came before the shell turn.
        const forkId = ThreadId.make("thread:opencode2-live-inbox-fork");
        yield* orchestrator.dispatch({
          type: "thread.fork",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:opencode2-live-inbox:fork"),
          sourceThreadId: threadId,
          targetThreadId: forkId,
          sourcePoint: { type: "run", runId: first.runs[0]!.id },
        });
        // In its own worktree, so the source's rollback below restores files for
        // the source alone. The fork's session moves there with it.
        const forkWork = path.join(ROOT, "inbox-fork-work");
        yield* fs.makeDirectory(forkWork, { recursive: true });
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("command:opencode2-live-inbox:fork-worktree"),
          threadId: forkId,
          worktreePath: forkWork,
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:opencode2-live-inbox:fork-ask"),
          threadId: forkId,
          messageId: MessageId.make("message:opencode2-live-inbox:fork-ask"),
          text: "Did I ask you to reply with QUEUED_B in this conversation? Answer only YES or NO.",
          attachments: [],
          modelSelection: MODEL,
          dispatchMode: { type: "start_immediately" },
        });
        const forked = yield* waitFor(forkId, settled);
        assert.equal(forked.contextTransfers[0]?.resolution?.strategy, "native_fork");
        assert.equal(forked.runs[0]?.status, "completed");
        assert.include(assistantText(forked, forked.runs[0]!.id).toUpperCase(), "NO");

        // 4. Roll the source back to the first turn: OpenCode's history drops the
        // later turns and T3's checkpoint puts ALPHA back.
        const checkpoint = drained.checkpoints.find(
          (candidate) => candidate.appRunOrdinal === 1 && candidate.status === "ready",
        );
        assert.isDefined(checkpoint);
        yield* orchestrator.dispatch({
          type: "checkpoint.rollback",
          commandId: CommandId.make("command:opencode2-live-inbox:rollback"),
          threadId,
          scopeId: checkpoint!.scopeId,
          checkpointId: checkpoint!.id,
        });
        const rolledBack = yield* waitFor(threadId, (projection) =>
          projection.runs.slice(1).every((run) => run.status === "rolled_back"),
        );
        assert.deepEqual(
          rolledBack.runs.map((run) => run.status),
          ["completed", "rolled_back", "rolled_back", "rolled_back"],
        );
        assert.equal((yield* fs.readFileString(path.join(work, "reverted.txt"))).trim(), "ALPHA");
        yield* dispatch(
          "after",
          "Did I ask you to reply with QUEUED_B in this conversation? Answer only YES or NO.",
          { type: "start_immediately" },
        );
        const after = yield* waitFor(
          threadId,
          (projection) => projection.runs.length === 5 && settled(projection),
        );
        assert.include(assistantText(after, after.runs[4]!.id).toUpperCase(), "NO");
        // OpenCode's own history kept only the first turn before the new one.
        const sessionId = after.providerThreads[0]?.nativeThreadRef?.nativeId;
        const db = new NodeSqlite.DatabaseSync(`${ROOT}/data/opencode/opencode.db`, {
          readOnly: true,
        });
        const userMessages = db
          .prepare(
            "SELECT id FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY seq",
          )
          .all(sessionId!)
          .map((row) => String(row.id));
        db.close();
        assert.lengthOf(userMessages, 2);
      }).pipe(Effect.provide(Layer.merge(liveLayer, NodeServices.layer)), Effect.scoped),
    600_000,
  );

  it.live(
    "runs plan mode, a workspace command and skill, and /compact through the real driver",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const work = path.join(ROOT, "work");
        yield* fs.makeDirectory(path.join(work, ".opencode", "command"), { recursive: true });
        yield* fs.makeDirectory(path.join(work, ".opencode", "skills", "greet"), {
          recursive: true,
        });
        yield* fs.writeFileString(
          path.join(work, ".opencode", "command", "hello.md"),
          "---\ndescription: Say hello to the workspace\n---\nReply with exactly: HELLO $ARGUMENTS\n",
        );
        yield* fs.writeFileString(
          path.join(work, ".opencode", "skills", "greet", "SKILL.md"),
          "---\nname: greet\ndescription: Greets the user with the secret word MANGO.\n---\nWhen this skill is active, begin your reply with the exact word MANGO.\n",
        );
        yield* EffectWorker.runDaemonWithOptions({ concurrency: 2 }).pipe(Effect.forkScoped);

        // The workspace's own command and skill reach the composer's pickers.
        const instance =
          yield* (yield* ProviderInstanceRegistry.ProviderInstanceRegistry).getInstance(INSTANCE);
        assert.isDefined(instance);
        const workspace = yield* instance!.snapshotForCwd!(work);
        assert.include(
          workspace.skills.map((skill) => skill.name),
          "greet",
        );
        assert.includeMembers(
          workspace.slashCommands.map((command) => command.name),
          ["compact", "hello"],
        );

        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make("thread:opencode2-live-modes");
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:opencode2-live-modes:create"),
          threadId,
          projectId: ProjectId.make("project:opencode2-live-modes"),
          title: "OpenCode 2 live modes",
          modelSelection: MODEL,
          runtimeMode: "full-access",
          interactionMode: "plan",
          branch: null,
          worktreePath: work,
        });
        const runs = (count: number) => (projection: OrchestrationV2ThreadProjection) =>
          projection.runs.length === count && settled(projection);
        const lastReply = (projection: OrchestrationV2ThreadProjection) =>
          projection.turnItems.findLast((item) => item.type === "assistant_message");

        // Plan mode is OpenCode's plan agent: it plans instead of editing.
        yield* send(
          threadId,
          "modes-plan",
          "Plan how to add a --verbose flag to a script named cli.js; the file may not exist yet, so plan it from scratch. Do not ask me anything. Present a short plan; do not implement it.",
        );
        const planned = yield* waitFor(threadId, runs(1));
        assert.equal(planned.runs[0]?.status, "completed");
        const sessionId = planned.providerThreads[0]?.nativeThreadRef?.nativeId;
        assert.isDefined(sessionId);
        const planSteps = yield* assistantAgents(sessionId!);
        assert.isAbove(planSteps.length, 0);
        assert.isTrue(planSteps.every((agent) => agent === "plan"));

        yield* orchestrator.dispatch({
          type: "thread.interaction-mode.set",
          commandId: CommandId.make("command:opencode2-live-modes:default"),
          threadId,
          interactionMode: "default",
        });
        yield* send(threadId, "modes-command", "/hello WORLD");
        const commanded = yield* waitFor(threadId, runs(2));
        assert.equal(commanded.runs[1]?.status, "completed");
        assert.include(lastReply(commanded)?.text ?? "", "HELLO WORLD");
        assert.equal((yield* assistantAgents(sessionId!)).at(-1), "build");

        yield* send(threadId, "modes-skill", "Use $greet to say hi in three words.");
        const skilled = yield* waitFor(threadId, runs(3));
        assert.equal(skilled.runs[2]?.status, "completed");
        assert.include(lastReply(skilled)?.text ?? "", "MANGO");

        yield* send(threadId, "modes-compact", "/compact");
        const compacted = yield* waitFor(threadId, runs(4));
        assert.equal(compacted.runs[3]?.status, "completed");
        const compaction = compacted.turnItems.find((item) => item.type === "compaction");
        assert.equal(compaction?.status, "completed");
        assert.equal(compaction?.runId, compacted.runs[3]?.id);
        assert.isAbove(
          compaction?.type === "compaction" ? (compaction.summary ?? "").length : 0,
          0,
        );
      }).pipe(Effect.provide(Layer.merge(liveLayer, NodeServices.layer)), Effect.scoped),
    360_000,
  );

  it.live(
    "generates a title, calls T3's MCP server, and reconciles a turn cut off by a killed server",
    () =>
      Effect.gen(function* () {
        const work = `${ROOT}/work`;
        yield* EffectWorker.runDaemonWithOptions({ concurrency: 2 }).pipe(Effect.forkScoped);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const instance =
          yield* (yield* ProviderInstanceRegistry.ProviderInstanceRegistry).getInstance(INSTANCE);
        assert.isDefined(instance);
        yield* instance!.snapshot.refresh;

        // A thread title, generated in a temporary session on the 2.x server.
        const title = yield* instance!.textGeneration.generateThreadTitle({
          cwd: work,
          message: "fix the login redirect loop after oauth",
          modelSelection: MODEL,
        });
        assert.isAbove(title.title.length, 0);

        const threadId = ThreadId.make("thread:opencode2-live-restart");
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:opencode2-live-restart:create"),
          threadId,
          projectId: ProjectId.make("project:opencode2-live-restart"),
          title: "OpenCode 2 live restart",
          modelSelection: MODEL,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: work,
        });
        const runs = (count: number) => (projection: OrchestrationV2ThreadProjection) =>
          projection.runs.length === count && settled(projection);

        // T3's MCP server for this thread: the stand-in's one tool answers a marker.
        if (process.env.OPENCODE2_MCP_URL !== undefined) {
          yield* send(
            threadId,
            "restart-mcp",
            "Call the echo_marker tool from the T3 Code MCP server with word 'kiwi', then reply with its exact output and nothing else.",
          );
          const called = yield* waitFor(threadId, runs(1));
          assert.equal(called.runs[0]?.status, "completed");
          const reply = called.turnItems.findLast((item) => item.type === "assistant_message");
          assert.include(reply?.type === "assistant_message" ? reply.text : "", "MARKER-KIWI-7Q9");
        }
        const before = (yield* orchestrator.getThreadProjection(threadId)).runs.length;

        // The spawned server dies mid-command; T3 restarts it and settles the turn.
        yield* send(
          threadId,
          "restart-killed",
          "Run the shell command `sleep 60 && echo LATE` with the shell tool in the foreground and wait for it, then reply DONE.",
        );
        yield* waitFor(threadId, (projection) =>
          projection.turnItems.some(
            (item) =>
              item.type === "command_execution" &&
              item.status === "running" &&
              item.input.includes("sleep 60"),
          ),
        );
        const pid = spawnedPids.at(-1);
        assert.isDefined(pid);
        process.kill(pid!, "SIGKILL");
        const reconciled = yield* waitFor(threadId, runs(before + 1));
        assert.equal(reconciled.runs.at(-1)?.status, "interrupted");

        yield* send(
          threadId,
          "restart-next",
          "What did I last ask you to run? Answer in one short sentence.",
        );
        const next = yield* waitFor(threadId, runs(before + 2));
        assert.equal(next.runs.at(-1)?.status, "completed");
        const answer = next.turnItems.findLast((item) => item.type === "assistant_message");
        assert.include(answer?.type === "assistant_message" ? answer.text : "", "sleep 60");
        assert.lengthOf(next.providerThreads, 1);
      }).pipe(Effect.provide(Layer.merge(liveLayer, NodeServices.layer)), Effect.scoped),
    360_000,
  );

  // Needs an external server behind a proxy that cuts its event streams on
  // `GET <proxy>/__drop`, so only the stream drops while the server stays up.
  it.live.runIf(process.env.OPENCODE2_DROP_URL !== undefined)(
    "picks a turn back up after an external server's event stream drops mid-turn",
    () =>
      Effect.gen(function* () {
        const work = `${ROOT}/work`;
        yield* EffectWorker.runDaemonWithOptions({ concurrency: 2 }).pipe(Effect.forkScoped);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make("thread:opencode2-live-drop");
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:opencode2-live-drop:create"),
          threadId,
          projectId: ProjectId.make("project:opencode2-live-drop"),
          title: "OpenCode 2 live drop",
          modelSelection: MODEL,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: work,
        });
        yield* send(
          threadId,
          "drop-running",
          "Run the shell command `sleep 8 && echo AFTER_DROP` with the shell tool in the foreground and wait for it, then reply with its exact output.",
        );
        yield* waitFor(threadId, (projection) =>
          projection.turnItems.some(
            (item) => item.type === "command_execution" && item.status === "running",
          ),
        );
        yield* HttpClient.get(process.env.OPENCODE2_DROP_URL!).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.orDie,
        );
        // The turn keeps running on the new stream and ends with its reply.
        const done = yield* waitFor(threadId, settled);
        assert.equal(done.runs[0]?.status, "completed");
        const shell = done.turnItems.find((item) => item.type === "command_execution");
        assert.equal(shell?.status, "completed");
        const reply = done.turnItems.findLast((item) => item.type === "assistant_message");
        assert.include(reply?.type === "assistant_message" ? reply.text : "", "AFTER_DROP");
        // The thread's T3 MCP server is registered on the external server for now.
        const opencode = yield* OpenCode2Client.make.pipe(Effect.provide(FetchHttpClient.layer));
        const api = yield* opencode.connect({
          baseUrl: process.env.OPENCODE2_SERVER_URL!,
          password: process.env.OPENCODE2_SERVER_PASSWORD ?? "",
        });
        const servers = yield* api.client.mcp.list({ location: { directory: work } });
        assert.deepEqual(
          servers.data.map((server) => server.name),
          [],
          "an external server gets no T3 MCP server, as with 1.x",
        );
      }).pipe(Effect.provide(Layer.merge(liveLayer, NodeServices.layer)), Effect.scoped),
    360_000,
  );
});
