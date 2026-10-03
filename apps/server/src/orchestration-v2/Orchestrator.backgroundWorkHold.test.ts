import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for background work holds"),
} as ProviderAdapterV2Shape;
const database = SqlitePersistenceMemory;
const testLayer = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "background-work-hold" },
    ProviderAdapterRegistry.makeLayer([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

it.layer(testLayer)("thread.background-work.hold", (it) => {
  it.effect("waits for the commands that run now, then stops waiting", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:background-work-hold");
      const runId = RunId.make("run:background-work-hold");
      const nodeId = NodeId.make("node:background-work-hold");
      const now = yield* DateTime.now;
      const hold = (commandId: string, held: boolean) =>
        orchestrator.dispatch({
          type: "thread.background-work.hold",
          commandId: CommandId.make(commandId),
          threadId,
          held,
        });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-background-work-hold"),
        threadId,
        projectId: ProjectId.make("project:background-work-hold"),
        title: "Benchmarks",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });

      // Nothing runs yet, so there is nothing to wait for. The MCP tool relies
      // on this tag to tell the rejection apart from an outage.
      const nothing = yield* Effect.flip(hold("hold-nothing", true));
      assert.equal(nothing._tag, "OrchestratorCommandRejectedError");

      // The turn ended and left its benchmark running in the background.
      yield* projections.apply({
        id: EventId.make("event:background-work-hold:run"),
        type: "run.created",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId: instanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:background-work-hold"),
          rootNodeId: nodeId,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projections.apply({
        id: EventId.make("event:background-work-hold:command"),
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId,
        driver,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("item:bench"),
          threadId,
          runId,
          nodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "running",
          title: "Run benchmarks",
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "command_execution",
          input: "cargo bench",
          output: "",
        },
      });
      const running = {
        taskId: "item:bench",
        description: "Run benchmarks",
        kind: "command" as const,
      };
      assert.deepEqual((yield* projections.getThreadShell(threadId))?.pendingBackgroundTasks, [
        running,
      ]);

      yield* hold("hold-bench", true);
      assert.deepEqual(
        (yield* projections.getThreadProjection(threadId)).thread.heldBackgroundTaskIds,
        ["item:bench"],
      );
      assert.deepEqual((yield* projections.getThreadShell(threadId))?.pendingBackgroundTasks, [
        { ...running, held: true },
      ]);

      yield* hold("release-bench", false);
      assert.isUndefined(
        (yield* projections.getThreadProjection(threadId)).thread.heldBackgroundTaskIds,
      );
      assert.deepEqual((yield* projections.getThreadShell(threadId))?.pendingBackgroundTasks, [
        running,
      ]);
    }),
  );
});
