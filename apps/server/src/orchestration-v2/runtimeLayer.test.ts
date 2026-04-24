import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { CheckpointStoreLive } from "../checkpointing/Layers/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import { GitCoreLive } from "../git/Layers/GitCore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { OrchestrationV2LayerLive } from "./runtimeLayer.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-runtime-layer-",
});

const GitCoreTestLayer = GitCoreLive.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provide(NodeServices.layer),
);

const CheckpointStoreTestLayer = CheckpointStoreLive.pipe(
  Layer.provide(GitCoreTestLayer),
  Layer.provide(NodeServices.layer),
);

const TestLayer = OrchestrationV2LayerLive.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(CheckpointStoreTestLayer),
  Layer.provide(ServerConfigLayer),
  Layer.provide(ServerSettingsService.layerTest()),
  Layer.provide(NodeServices.layer),
);

it.layer(TestLayer)("OrchestrationV2LayerLive", (it) => {
  it.effect("creates and reads a thread through the production V2 composition", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-thread");
      const projectId = ProjectId.make("runtime-layer-project");

      const result = yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("runtime-layer-create"),
        threadId,
        projectId,
        title: "Runtime layer thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });

      const projection = yield* orchestrator.getThreadProjection(threadId);

      assert.equal(result.sequence, 1);
      assert.equal(projection.thread.id, threadId);
      assert.equal(projection.thread.projectId, projectId);
      assert.equal(projection.thread.defaultProvider, "codex");
      assert.deepEqual(projection.runs, []);
    }),
  );
});
