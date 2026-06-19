import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe } from "vite-plus/test";

import { CheckpointStoreLive } from "../checkpointing/Layers/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { OrchestrationV2LayerLive } from "./runtimeLayer.ts";
import { GROK_MODEL_SELECTION } from "./testkit/fixtures/shared.ts";

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-grok-v2-live-",
});

const vcsDriverRegistryLayer = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(serverConfigLayer),
  Layer.provide(NodeServices.layer),
);

const checkpointStoreLayer = CheckpointStoreLive.pipe(Layer.provide(vcsDriverRegistryLayer));

const liveLayer = OrchestrationV2LayerLive.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(checkpointStoreLayer),
  Layer.provide(serverConfigLayer),
  Layer.provide(
    ServerSettingsService.layerTest({
      providers: {
        grok: { enabled: true },
      },
    }),
  ),
  Layer.provide(NodeServices.layer),
);

const waitForIdle = Effect.fn("GrokOrchestratorV2Live.waitForIdle")(function* (threadId: ThreadId) {
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
  return yield* Effect.die(new Error(`Timed out waiting for Grok thread ${threadId}.`));
});

describe.runIf(process.env.T3_GROK_LIVE_ORCHESTRATOR === "1")("Grok V2 live orchestrator", () => {
  it.live(
    "forks through portable context using real Grok ACP agents",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
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
          sourceProjection.runs.map((run) => [run.provider, run.status]),
          [["grok", "completed"]],
        );
        assert.deepEqual(
          targetProjection.runs.map((run) => [run.provider, run.status]),
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
      }).pipe(Effect.provide(liveLayer), Effect.scoped),
    360_000,
  );
});
