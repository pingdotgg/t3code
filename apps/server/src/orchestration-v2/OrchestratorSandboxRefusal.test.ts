import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata commands"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "sandbox-refusal" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:sandbox-refusal"),
      title: "Sandbox refusal",
      modelSelection: { instanceId, model: "gpt-5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

it.layer(layerTest)("sandbox workspace refusals", (it) => {
  it.effect("refuses a defer_start dispatch with a sandbox strategy and records no run", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:sandbox-defer");
      yield* createThread(threadId);
      const refused = yield* orchestrator
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("dispatch:sandbox-defer"),
          threadId,
          messageId: MessageId.make("message:sandbox-defer"),
          text: "Run this in a worker",
          attachments: [],
          modelSelection: { instanceId, model: "gpt-5" },
          dispatchMode: {
            type: "defer_start",
            workspaceStrategy: { type: "sandbox" },
          },
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "OrchestratorDispatchError");
      assert.match(String(refused.cause), /isolation 'openshell-auto'/);
      const records = yield* projections.getThreadRecords(threadId, ["runs"]);
      assert.equal(records.runs.length, 0);
    }),
  );

  it.effect("refuses a delegated task with a sandbox strategy", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const parentThreadId = ThreadId.make("thread:sandbox-delegate-parent");
      yield* createThread(parentThreadId);
      const refused = yield* orchestrator
        .dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make("dispatch:sandbox-delegate"),
          parentThreadId,
          parentRunId: "run:sandbox-delegate" as never,
          parentNodeId: "node:sandbox-delegate" as never,
          task: "Build this in a worker",
          modelSelection: { instanceId, model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "sandbox" },
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "OrchestratorDispatchError");
      assert.match(String(refused.cause), /isolation 'openshell-auto'/);
    }),
  );
});
