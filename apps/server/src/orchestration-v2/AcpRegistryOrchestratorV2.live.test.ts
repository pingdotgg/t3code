import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
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
import { FetchHttpClient } from "effect/unstable/http";
import { describe } from "vite-plus/test";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProviderInstanceRegistryHydrationLive } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from "../provider/Layers/ProviderEventLoggers.ts";
import { OpenCodeRuntimeLive } from "../provider/opencodeRuntime.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { OrchestrationV2LayerLive } from "./runtimeLayer.ts";
import { layer as mcpSessionRegistryTestLayer } from "../mcp/McpSessionRegistry.testkit.ts";

const liveAgentId = process.env.T3_ACP_REGISTRY_LIVE_AGENT_ID?.trim() || "devin";
const liveCommandPath = process.env.T3_ACP_REGISTRY_LIVE_COMMAND?.trim();
const liveInstanceId = ProviderInstanceId.make("acpRegistry_live");
const liveModelSelection = {
  instanceId: liveInstanceId,
  model: "default",
} satisfies ModelSelection;

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-acp-registry-v2-live-",
});

const vcsDriverRegistryLayer = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(serverConfigLayer),
  Layer.provide(NodeServices.layer),
);

const checkpointStoreLayer = CheckpointStore.layer.pipe(Layer.provide(vcsDriverRegistryLayer));

const serverSettingsLayer = ServerSettingsService.layerTest({
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
const providerInstanceRegistryLayer = ProviderInstanceRegistryHydrationLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      serverConfigLayer.pipe(Layer.provide(NodeServices.layer)),
      serverSettingsLayer,
      NodeServices.layer,
      FetchHttpClient.layer,
      OpenCodeRuntimeLive.pipe(Layer.provide(NodeServices.layer)),
      Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
    ),
  ),
);

const liveLayer = OrchestrationV2LayerLive.pipe(
  Layer.provide(mcpSessionRegistryTestLayer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(checkpointStoreLayer),
  Layer.provide(serverConfigLayer),
  Layer.provide(serverSettingsLayer),
  Layer.provide(providerInstanceRegistryLayer),
  Layer.provide(NodeServices.layer),
);

const waitForIdle = Effect.fn("AcpRegistryOrchestratorV2Live.waitForIdle")(function* (
  threadId: ThreadId,
  expectedRunCount: number,
) {
  const orchestrator = yield* OrchestratorV2;
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

describe.runIf(process.env.T3_ACP_REGISTRY_LIVE_ORCHESTRATOR === "1")(
  "ACP Registry V2 live orchestrator",
  () => {
    it.live(
      "runs and resumes a real registry agent through the production V2 harness",
      () =>
        Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
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
        }).pipe(Effect.provide(liveLayer), Effect.scoped),
      480_000,
    );
  },
);
