/**
 * Runs OpenCode 2 through the whole orchestrator with the real driver: the
 * driver probes the binary, spawns `opencode serve`, and routes to the 2.x
 * adapter. One turn reads a file and runs a shell command; a second is
 * stopped while its shell command runs.
 *
 *   OPENCODE2_BIN=/path/to/opencode vp test run src/orchestration-v2/OpenCode2OrchestratorV2.live.test.ts
 *
 * The server runs with isolated HOME and XDG directories on the free
 * `opencode/big-pickle` model; `OPENCODE2_MODEL` picks another.
 */
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqlite from "node:sqlite";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
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
import { FetchHttpClient } from "effect/unstable/http";
import { describe } from "vite-plus/test";

import * as ResetCreditCoordinator from "../provider/Layers/resetCreditCoordinator.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "../background/HostPowerMonitor.ts";
import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { AntigravityInstallation } from "../provider/AntigravityInstallation.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import { ProviderInstanceRegistryHydrationLive } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from "../provider/Layers/ProviderEventLoggers.ts";
import { OpenCodeRuntimeLive } from "../provider/opencodeRuntime.ts";
import * as OpenCodeServerLedger from "../provider/OpenCodeServerLedger.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { runDaemonWithOptions as runEffectWorkerDaemonWithOptions } from "./EffectWorker.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { worktreeRepairDependenciesTestLayer } from "./ProviderTurnStartService.testkit.ts";
import { OrchestrationV2LayerLive } from "./runtimeLayer.ts";
import { layer as mcpSessionRegistryTestLayer } from "../mcp/McpSessionRegistry.testkit.ts";

const binaryPath = process.env.OPENCODE2_BIN;
const ROOT = process.env.OPENCODE2_LIVE_ROOT ?? "";
const INSTANCE = ProviderInstanceId.make("opencode");
const MODEL: ModelSelection = {
  instanceId: INSTANCE,
  model: process.env.OPENCODE2_MODEL ?? "opencode/big-pickle",
};
// The free model the thread switches to mid-conversation.
const SWITCHED_MODEL = "opencode/mimo-v2.6-flash-free";

const PlatformTestLayer = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry)({ resolveLink: () => Effect.die("unused title link") }),
);
const serverConfigLayer = ServerConfig.layerTest(`${ROOT}/work`, { prefix: "t3-opencode2-live-" });
const vcsDriverRegistryLayer = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(serverConfigLayer),
  Layer.provide(PlatformTestLayer),
);
// Isolated OpenCode state: the server never touches the developer's own data.
const serverSettingsLayer = ServerSettingsService.layerTest({
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
      config: { enabled: true, binaryPath },
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
      OpenCodeRuntimeLive.pipe(
        Layer.provide(OpenCodeServerLedger.layerTest),
        Layer.provide(PlatformTestLayer),
      ),
      Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
      ModelManifest.layerTest,
      AntigravityInstallation.layer.pipe(
        Layer.provide(serverConfigLayer.pipe(Layer.provide(PlatformTestLayer))),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(PlatformTestLayer),
      ),
    ),
  ),
);
const liveLayer = OrchestrationV2LayerLive.pipe(
  Layer.provide(worktreeRepairDependenciesTestLayer),
  Layer.provide(mcpSessionRegistryTestLayer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(CheckpointStore.layer.pipe(Layer.provide(vcsDriverRegistryLayer))),
  Layer.provide(serverConfigLayer),
  Layer.provide(serverSettingsLayer),
  Layer.provide(providerInstanceRegistryLayer),
  Layer.provide(ResetCreditCoordinator.layer),
  Layer.provide(backgroundPolicyLayer),
  Layer.provide(PlatformTestLayer),
);

const settled = (projection: OrchestrationV2ThreadProjection) =>
  projection.runs.length > 0 &&
  projection.runs.every(
    (run) => !["queued", "starting", "running", "waiting"].includes(run.status),
  );

const waitFor = Effect.fn("OpenCode2Live.waitFor")(function* (
  threadId: ThreadId,
  done: (projection: OrchestrationV2ThreadProjection) => boolean,
) {
  const orchestrator = yield* OrchestratorV2;
  for (let attempt = 0; attempt < 240; attempt += 1) {
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
  const orchestrator = yield* OrchestratorV2;
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
  Schema.Struct({ model: Schema.Struct({ providerID: Schema.String, id: Schema.String }) }),
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

describe.runIf(binaryPath !== undefined && ROOT !== "")("OpenCode 2 live orchestrator", () => {
  it.live(
    "runs a tool turn and stops a running shell command through the real driver",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.writeFileString(path.join(ROOT, "work", "hello.txt"), "hello from t3 live\n");
        yield* runEffectWorkerDaemonWithOptions({ concurrency: 2 }).pipe(Effect.forkScoped);
        const orchestrator = yield* OrchestratorV2;
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

        // Supervised threads are refused, not run with every tool allowed.
        yield* orchestrator.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("command:opencode2-live:runtime-mode"),
          threadId,
          runtimeMode: "approval-required",
        });
        yield* send(threadId, "supervised", "Create a file named supervised.txt containing NO.");
        const refused = yield* waitFor(
          threadId,
          (projection) => projection.runs.length === 4 && settled(projection),
        );
        assert.equal(refused.runs.at(-1)?.status, "failed");
        assert.isFalse(yield* fs.exists(path.join(ROOT, "work", "supervised.txt")));
      }).pipe(Effect.provide(Layer.merge(liveLayer, NodeServices.layer)), Effect.scoped),
    360_000,
  );
});
