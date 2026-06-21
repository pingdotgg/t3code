import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
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
import { CURSOR_MODEL_SELECTION } from "./testkit/fixtures/shared.ts";

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-cursor-v2-live-",
});

const vcsDriverRegistryLayer = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(serverConfigLayer),
  Layer.provide(NodeServices.layer),
);

const checkpointStoreLayer = CheckpointStore.layer.pipe(Layer.provide(vcsDriverRegistryLayer));

const serverSettingsLayer = ServerSettingsService.layerTest({
  providers: {
    cursor: { enabled: true },
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

const waitForIdle = Effect.fn("CursorOrchestratorV2Live.waitForIdle")(function* (
  threadId: ThreadId,
) {
  const orchestrator = yield* OrchestratorV2;
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
  return yield* Effect.die(new Error(`Timed out waiting for Cursor thread ${threadId}.`));
});

describe.runIf(process.env.T3_CURSOR_LIVE_ORCHESTRATOR === "1")(
  "Cursor V2 live orchestrator",
  () => {
    it.live(
      "forks through portable context using real Cursor agents",
      () =>
        Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          const projectId = ProjectId.make("project:cursor-live-portable-fork");
          const sourceThreadId = ThreadId.make("thread:cursor-live-portable-fork:source");
          const targetThreadId = ThreadId.make("thread:cursor-live-portable-fork:target");
          const marker = "CURSOR_LIVE_PORTABLE_FORK_7H3Q";

          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:cursor-live-portable-fork:create"),
            threadId: sourceThreadId,
            projectId,
            title: "Cursor live portable fork source",
            modelSelection: CURSOR_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:cursor-live-portable-fork:source"),
            threadId: sourceThreadId,
            messageId: MessageId.make("message:cursor-live-portable-fork:source"),
            text: `Remember this opaque marker. Respond with exactly: ${marker}`,
            attachments: [],
            modelSelection: CURSOR_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          });
          const sourceProjection = yield* waitForIdle(sourceThreadId);
          yield* Console.log("Cursor live source turn completed; dispatching portable fork.");

          yield* orchestrator.dispatch({
            type: "thread.fork",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:cursor-live-portable-fork:fork"),
            sourceThreadId,
            targetThreadId,
            sourcePoint: { type: "latest_stable" },
            title: "Cursor live portable fork target",
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:cursor-live-portable-fork:target"),
            threadId: targetThreadId,
            messageId: MessageId.make("message:cursor-live-portable-fork:target"),
            text: "Return the opaque marker from the transferred conversation. Respond with only the marker.",
            attachments: [],
            modelSelection: CURSOR_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          });
          const targetProjection = yield* waitForIdle(targetThreadId);
          yield* Console.log("Cursor live portable fork target completed.");

          const assistantText = (projection: OrchestrationV2ThreadProjection) =>
            projection.messages
              .filter((message) => message.role === "assistant")
              .map((message) => message.text)
              .join("\n");

          assert.deepEqual(
            sourceProjection.runs.map((run) => [run.providerInstanceId, run.status]),
            [["cursor", "completed"]],
          );
          assert.deepEqual(
            targetProjection.runs.map((run) => [run.providerInstanceId, run.status]),
            [["cursor", "completed"]],
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
        }).pipe(Effect.provide(liveLayer), Effect.scoped),
      360_000,
    );
  },
);
