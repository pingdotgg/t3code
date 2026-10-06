import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  CommandId,
  MessageId,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ResetCreditCoordinator from "../provider/resetCreditCoordinator.ts";
import { FetchHttpClient } from "effect/http";
import { describe } from "vite-plus/test";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "../background/HostPowerMonitor.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AntigravityInstallation from "../provider/AntigravityInstallation.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ProviderInstanceRegistryHydration from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ProviderEventLoggers from "../provider/ProviderEventLoggers.ts";
import * as OpenCodeRuntime from "../provider/opencodeRuntime.ts";
import * as OpenCodeServerLedger from "../provider/OpenCodeServerLedger.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderTurnStartServiceTestkit from "./ProviderTurnStartService.testkit.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { GROK_MODEL_SELECTION } from "./testkit/fixtures/shared.ts";

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-grok-v2-live-",
});

const layerVcsDriverRegistry = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);

const layerCheckpointStore = CheckpointStore.layer.pipe(Layer.provide(layerVcsDriverRegistry));

const layerServerSettings = ServerSettings.layerTest({
  providers: {
    grok: { enabled: true },
  },
});
const layerBackgroundPolicy = BackgroundPolicy.layer.pipe(
  Layer.provide(Layer.effect(HostPowerMonitor.HostPowerMonitor, HostPowerMonitor.make())),
  Layer.provide(layerServerSettings),
);
const layerProviderInstanceRegistry = ProviderInstanceRegistryHydration.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerServerConfig.pipe(Layer.provide(layerPlatformTest)),
      layerServerSettings,
      ServerSecretStore.layer.pipe(
        Layer.provide(layerServerConfig),
        Layer.provide(layerPlatformTest),
      ),
      NodeServices.layer,
      FetchHttpClient.layer,
      OpenCodeRuntime.layer.pipe(
        Layer.provide(OpenCodeServerLedger.layerTest),
        Layer.provide(layerPlatformTest),
      ),
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
      ModelManifest.layerTest,
      AntigravityInstallation.AntigravityInstallation.layer.pipe(
        Layer.provide(layerServerConfig.pipe(Layer.provide(layerPlatformTest))),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(layerPlatformTest),
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

const layerLive = RuntimeLayer.layer.pipe(
  Layer.provide(ProviderTurnStartServiceTestkit.layer),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStore),
  Layer.provide(layerServerConfig),
  Layer.provide(layerServerSettings),
  Layer.provide(layerProviderInstanceRegistry),
  Layer.provide(ResetCreditCoordinator.layer),
  Layer.provide(layerBackgroundPolicy),
  Layer.provide(layerPlatformTest),
);

const waitForIdle = Effect.fn("GrokOrchestratorV2Live.waitForIdle")(function* (threadId: ThreadId) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const projection = yield* orchestrator.getThreadProjection(threadId);
    if (
      projection.runs.length > 0 &&
      projection.runs.every(
        (run) => !["queued", "starting", "running", "waiting"].includes(run.status),
      )
    ) {
      return projection;
    }
    yield* Effect.sleep("500 millis");
  }
  return yield* Effect.die(new Error(`Timed out waiting for Grok thread ${threadId}.`));
});

describe.runIf(process.env.T3_GROK_LIVE_ORCHESTRATOR === "1")("Grok V2 live orchestrator", () => {
  it.live(
    "forks through portable context using real Grok ACP agents",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projectId = ProjectId.make("project:grok-live-portable-fork");
        const sourceThreadId = ThreadId.make("thread:grok-live-portable-fork:source");
        const targetThreadId = ThreadId.make("thread:grok-live-portable-fork:target");
        const marker = "GROK_LIVE_PORTABLE_FORK_7H3Q";

        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:grok-live-portable-fork:create"),
          threadId: sourceThreadId,
          projectId,
          title: "Grok live portable fork source",
          modelSelection: GROK_MODEL_SELECTION,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        yield* Console.log("Grok live source thread created; dispatching source prompt.");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:grok-live-portable-fork:source"),
          threadId: sourceThreadId,
          messageId: MessageId.make("message:grok-live-portable-fork:source"),
          text: `Remember this opaque marker. Respond with exactly: ${marker}`,
          attachments: [],
          modelSelection: GROK_MODEL_SELECTION,
          dispatchMode: { type: "start_immediately" },
        });
        yield* Console.log("Grok live source prompt dispatched; waiting for completion.");
        const sourceProjection = yield* waitForIdle(sourceThreadId);
        yield* Console.log("Grok live source turn completed; dispatching portable fork.");

        yield* orchestrator.dispatch({
          type: "thread.fork",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:grok-live-portable-fork:fork"),
          sourceThreadId,
          targetThreadId,
          sourcePoint: { type: "latest_stable" },
          title: "Grok live portable fork target",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:grok-live-portable-fork:target"),
          threadId: targetThreadId,
          messageId: MessageId.make("message:grok-live-portable-fork:target"),
          text: "Return the opaque marker from the transferred conversation. Respond with only the marker.",
          attachments: [],
          modelSelection: GROK_MODEL_SELECTION,
          dispatchMode: { type: "start_immediately" },
        });
        const targetProjection = yield* waitForIdle(targetThreadId);
        yield* Console.log("Grok live portable fork target completed.");

        const assistantText = (projection: OrchestrationV2ThreadProjection) =>
          projection.messages
            .filter((message) => message.role === "assistant")
            .map((message) => message.text)
            .join("\n");

        assert.deepEqual(
          sourceProjection.runs.map((run) => [run.providerInstanceId, run.status]),
          [["grok", "completed"]],
        );
        assert.deepEqual(
          targetProjection.runs.map((run) => [run.providerInstanceId, run.status]),
          [["grok", "completed"]],
        );
        assert.deepEqual(
          targetProjection.contextTransfers.map((transfer) => [
            transfer.type,
            transfer.status,
            transfer.resolution?.strategy,
          ]),
          [["fork", "consumed", "portable_context"]],
        );
        assert.deepEqual(
          targetProjection.contextHandoffs.map((handoff) => handoff.strategy),
          ["full_thread_summary"],
        );
        assert.include(targetProjection.contextHandoffs[0]?.summaryText ?? "", marker);
        assert.include(assistantText(targetProjection), marker);
      }).pipe(Effect.provide(layerLive), Effect.scoped),
    360_000,
  );
});
