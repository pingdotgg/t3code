import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  CommandId,
  type ModelSelection,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
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
import { OpenCodeRuntime } from "@t3tools/provider-opencode/server";
import { OpenCodeServerLedger } from "@t3tools/provider-opencode/server";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderTurnStartServiceTestkit from "./ProviderTurnStartService.testkit.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";

// The Antigravity switch is a durable, named conformance fixture for Google's
// official Registry distribution. It uses credentials already owned by the
// Antigravity agent and never stores them in the test database.
//
// T3_ACP_ANTIGRAVITY_LIVE=1 ../../node_modules/.bin/vp test run \
//   src/orchestration-v2/AcpRegistryOrchestratorV2.live.test.ts
const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const runAntigravityFixture = process.env.T3_ACP_ANTIGRAVITY_LIVE === "1";
const liveAgentId = runAntigravityFixture
  ? "antigravity-acp"
  : process.env.T3_ACP_REGISTRY_LIVE_AGENT_ID?.trim() || "devin";
const liveCommandPath = process.env.T3_ACP_REGISTRY_LIVE_COMMAND?.trim();
const liveInstanceId = ProviderInstanceId.make("acpRegistry_live");
const liveModelSelection = {
  instanceId: liveInstanceId,
  model: "default",
} satisfies ModelSelection;

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-acp-registry-v2-live-",
});

const layerVcsDriverRegistry = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);

const layerCheckpointStore = CheckpointStore.layer.pipe(Layer.provide(layerVcsDriverRegistry));

const layerServerSettings = ServerSettings.layerTest({
  providerInstances: {
    [liveInstanceId]: {
      driver: ProviderDriverKind.make("acpRegistry"),
      displayName: `ACP Registry: ${liveAgentId}`,
      enabled: true,
      config: {
        agentId: liveAgentId,
        ...(liveCommandPath ? { commandPath: liveCommandPath } : {}),
      },
    },
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
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStore),
  Layer.provide(layerServerConfig),
  Layer.provide(layerServerSettings),
  Layer.provide(layerProviderInstanceRegistry),
  Layer.provide(ResetCreditCoordinator.layer),
  Layer.provide(layerBackgroundPolicy),
  Layer.provide(ProviderTurnStartServiceTestkit.layer),
  Layer.provide(layerPlatformTest),
);

const waitForIdle = Effect.fn("AcpRegistryOrchestratorV2Live.waitForIdle")(function* (
  threadId: ThreadId,
  expectedRunCount: number,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const projection = yield* orchestrator.getThreadProjection(threadId);
    if (
      projection.runs.length >= expectedRunCount &&
      projection.runs.every(
        (run) => !["queued", "starting", "running", "waiting"].includes(run.status),
      )
    ) {
      return projection;
    }
    yield* Effect.sleep("500 millis");
  }
  return yield* Effect.die(new Error(`Timed out waiting for ACP Registry thread ${threadId}.`));
});

describe.runIf(runAntigravityFixture || process.env.T3_ACP_REGISTRY_LIVE_ORCHESTRATOR === "1")(
  "ACP Registry V2 live orchestrator",
  () => {
    it.live(
      `runs and resumes ${runAntigravityFixture ? "Google Antigravity" : "a real registry agent"} through the production V2 harness`,
      () =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const projectId = ProjectId.make("project:acp-registry-live");
          const threadId = ThreadId.make("thread:acp-registry-live");
          const marker = "ACP_REGISTRY_LIVE_7H3Q";

          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:acp-registry-live:create"),
            threadId,
            projectId,
            title: `ACP Registry live: ${liveAgentId}`,
            modelSelection: liveModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          yield* Console.log(
            `ACP Registry thread created for '${liveAgentId}'; dispatching first prompt.`,
          );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:acp-registry-live:first"),
            threadId,
            messageId: MessageId.make("message:acp-registry-live:first"),
            text: `Remember this opaque marker. Respond with exactly: ${marker}`,
            attachments: [],
            modelSelection: liveModelSelection,
            dispatchMode: { type: "start_immediately" },
          });
          const firstProjection = yield* waitForIdle(threadId, 1);
          const firstAssistant = firstProjection.messages.findLast(
            (message) => message.role === "assistant",
          )?.text;

          assert.deepEqual(
            firstProjection.runs.map((run) => [run.providerInstanceId, run.status]),
            [[liveInstanceId, "completed"]],
          );
          assert.include(firstAssistant ?? "", marker);

          yield* Console.log("First ACP turn completed; dispatching continuation prompt.");
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:acp-registry-live:second"),
            threadId,
            messageId: MessageId.make("message:acp-registry-live:second"),
            text: "Return the opaque marker from the previous turn. Respond with only the marker.",
            attachments: [],
            modelSelection: liveModelSelection,
            dispatchMode: { type: "start_immediately" },
          });
          const finalProjection = yield* waitForIdle(threadId, 2);
          const finalAssistant = finalProjection.messages.findLast(
            (message) => message.role === "assistant",
          )?.text;

          assert.deepEqual(
            finalProjection.runs.map((run) => [run.providerInstanceId, run.status]),
            [
              [liveInstanceId, "completed"],
              [liveInstanceId, "completed"],
            ],
          );
          assert.include(finalAssistant ?? "", marker);
          assert.deepEqual(finalProjection.providerSessions.length, 2);
          assert.isAtLeast(finalProjection.providerThreads.length, 1);
          assert.deepEqual(
            finalProjection.providerTurns.map((turn) => turn.status),
            ["completed", "completed"],
          );
        }).pipe(Effect.provide(layerLive), Effect.scoped),
      480_000,
    );
  },
);
