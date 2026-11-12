import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { VcsProcessTimeoutError } from "@t3tools/contracts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CheckpointCaptureService from "./CheckpointCaptureService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerProjectionStoreTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);

const threadId = ThreadId.make("thread:checkpoint-capture-delegated");
const projectId = ProjectId.make("project:checkpoint-capture-delegated");
const runId = RunId.make("run:checkpoint-capture-delegated");
const scopeId = CheckpointScopeId.make("scope:checkpoint-capture-delegated");
const rootNodeId = NodeId.make("node:checkpoint-capture-delegated-root");
const taskId = NodeId.make("node:checkpoint-capture-task");
const deliveryMessageId = MessageId.make("message:checkpoint-capture-delivery");
const providerThreadId = ProviderThreadId.make("provider-thread:checkpoint-capture-delegated");
const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} as const;



it.layer(layerProjectionStoreTest)("CheckpointCaptureServiceV2", (it) => {
  it.effect("records the checkpoint of a cancelled run and keeps it cancelled", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const cancelledAt = DateTime.add(now, { seconds: 1 });
      const cancelledThreadId = ThreadId.make("thread:checkpoint-capture-cancelled");
      const cancelledRunId = RunId.make("run:checkpoint-capture-cancelled");
      const cancelledScopeId = CheckpointScopeId.make("scope:checkpoint-capture-cancelled");
      const cancelledRootNodeId = NodeId.make("node:checkpoint-capture-cancelled-root");
      const cancelledProviderThreadId = ProviderThreadId.make(
        "provider-thread:checkpoint-capture-cancelled",
      );
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-cancelled:thread"),
        type: "thread.created",
        threadId: cancelledThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: cancelledThreadId,
          projectId,
          title: "Checkpoint capture after cancel",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: cancelledThreadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      const runningRun: OrchestrationV2Run = {
        id: cancelledRunId,
        threadId: cancelledThreadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: cancelledProviderThreadId,
        userMessageId: MessageId.make("message:checkpoint-capture-cancelled"),
        rootNodeId: cancelledRootNodeId,
        activeAttemptId: null,
        status: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      const runningRootNode = {
        id: cancelledRootNodeId,
        threadId: cancelledThreadId,
        runId: cancelledRunId,
        parentNodeId: null,
        rootNodeId: cancelledRootNodeId,
        kind: "root_turn" as const,
        status: "running" as const,
        countsForRun: true,
        providerThreadId: cancelledProviderThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: cancelledScopeId,
        startedAt: now,
        completedAt: null,
      };
      const scope = {
        id: cancelledScopeId,
        threadId: cancelledThreadId,
        runId: cancelledRunId,
        nodeId: cancelledRootNodeId,
        parentScopeId: null,
        providerThreadId: cancelledProviderThreadId,
        kind: "root_run" as const,
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/repo",
        createdAt: now,
      };
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-cancelled:provider-thread"),
        type: "provider-thread.updated",
        threadId: cancelledThreadId,
        nodeId: cancelledRootNodeId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: cancelledProviderThreadId,
          driver,
          providerInstanceId,
          providerSessionId: null,
          appThreadId: cancelledThreadId,
          ownerNodeId: cancelledRootNodeId,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-cancelled:scope"),
        type: "checkpoint-scope.created",
        threadId: cancelledThreadId,
        runId: cancelledRunId,
        nodeId: cancelledRootNodeId,
        occurredAt: now,
        payload: scope,
      });
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-cancelled:baseline"),
        type: "checkpoint.captured",
        threadId: cancelledThreadId,
        nodeId: cancelledRootNodeId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: CheckpointId.make("checkpoint:cancelled-baseline-0"),
          threadId: cancelledThreadId,
          scopeId: cancelledScopeId,
          runId: null,
          nodeId: cancelledRootNodeId,
          parentCheckpointId: null,
          ordinalWithinScope: 0,
          appRunOrdinal: null,
          ref: CheckpointRef.make("checkpoint-ref:cancelled-baseline-0"),
          status: "ready",
          files: [],
          capturedAt: now,
        },
      });
      for (const [status, completedAt] of [
        ["running", null],
        ["cancelled", cancelledAt],
      ] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:checkpoint-capture-cancelled:run-${status}`),
          type: "run.updated",
          threadId: cancelledThreadId,
          runId: cancelledRunId,
          nodeId: cancelledRootNodeId,
          providerInstanceId,
          occurredAt: completedAt ?? now,
          payload: { ...runningRun, status, completedAt },
        });
        yield* projectionStore.apply({
          id: EventId.make(`event:checkpoint-capture-cancelled:node-${status}`),
          type: "node.updated",
          threadId: cancelledThreadId,
          runId: cancelledRunId,
          nodeId: cancelledRootNodeId,
          providerInstanceId,
          occurredAt: completedAt ?? now,
          payload: { ...runningRootNode, status, completedAt },
        });
      }

      const captured = {
        id: CheckpointId.make("checkpoint:cancelled-captured-1"),
        threadId: cancelledThreadId,
        scopeId: cancelledScopeId,
        runId: cancelledRunId,
        nodeId: cancelledRootNodeId,
        parentCheckpointId: CheckpointId.make("checkpoint:cancelled-baseline-0"),
        ordinalWithinScope: 1,
        appRunOrdinal: 1,
        ref: CheckpointRef.make("checkpoint-ref:cancelled-captured-1"),
        status: "ready" as const,
        files: [],
        capturedAt: cancelledAt,
      };
      const commits = yield* Ref.make(0);
      const layerCapture = CheckpointCaptureService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              materializeBaselineCheckpoint: () =>
                Effect.die("baseline materialization must be skipped when ordinal 0 is ready"),
              capture: () => Effect.succeed(captured),
            }),
            Layer.mock(EventSink.EventSinkV2)({
              commitCommand: (input) =>
                Effect.forEach(input.events, (event) => projectionStore.apply(event)).pipe(
                  Effect.andThen(Ref.update(commits, (count) => count + 1)),
                  Effect.as({ committed: true } as never),
                  Effect.orDie,
                ),
            }),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const service = yield* CheckpointCaptureService.CheckpointCaptureServiceV2;
        yield* service.execute({
          threadId: cancelledThreadId,
          runId: cancelledRunId,
          scopeId: cancelledScopeId,
        });
        yield* service.execute({
          threadId: cancelledThreadId,
          runId: cancelledRunId,
          scopeId: cancelledScopeId,
        });
      }).pipe(Effect.provide(layerCapture));

      assert.equal(yield* Ref.get(commits), 1);
      const projected = yield* projectionStore.getCheckpointCaptureContext(cancelledThreadId, {
        runId: cancelledRunId,
        scopeId: cancelledScopeId,
      });
      assert.equal(projected.run?.status, "cancelled");
      assert.equal(projected.run?.checkpointId, captured.id);
      const completedAt = projected.run?.completedAt;
      assert.equal(
        completedAt ? DateTime.formatIso(completedAt) : completedAt,
        DateTime.formatIso(cancelledAt),
      );
      assert.equal(projected.rootNode?.status, "cancelled");
      assert.deepEqual([...projected.readyCheckpointOrdinals].toSorted(), [0, 1]);
    }),
  );
  it.effect("completes a side chat run with a missing checkpoint and never touches git", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const sideChatThreadId = ThreadId.make("thread:checkpoint-capture-side-chat");
      const sideChatRunId = RunId.make("run:checkpoint-capture-side-chat");
      const sideChatScopeId = CheckpointScopeId.make("scope:checkpoint-capture-side-chat");
      const sideChatRootNodeId = NodeId.make("node:checkpoint-capture-side-chat-root");
      const sideChatProviderThreadId = ProviderThreadId.make(
        "provider-thread:checkpoint-capture-side-chat",
      );
      const event = { threadId: sideChatThreadId, occurredAt: now };
      const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
        {
          ...event,
          id: EventId.make("event:checkpoint-capture-side-chat:thread"),
          type: "thread.created",
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: sideChatThreadId,
            projectId,
            title: "Side chat",
            providerInstanceId,
            modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: "/repo",
            activeProviderThreadId: null,
            lineage: {
              parentThreadId: threadId,
              relationshipToParent: "fork",
              rootThreadId: threadId,
              sideChat: true,
            },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        },
        {
          ...event,
          id: EventId.make("event:checkpoint-capture-side-chat:provider-thread"),
          type: "provider-thread.updated",
          driver,
          providerInstanceId,
          payload: {
            id: sideChatProviderThreadId,
            driver,
            providerInstanceId,
            providerSessionId: null,
            appThreadId: sideChatThreadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          ...event,
          id: EventId.make("event:checkpoint-capture-side-chat:run"),
          type: "run.updated",
          runId: sideChatRunId,
          payload: {
            id: sideChatRunId,
            threadId: sideChatThreadId,
            ordinal: 1,
            providerInstanceId,
            modelSelection,
            providerThreadId: sideChatProviderThreadId,
            userMessageId: MessageId.make("message:checkpoint-capture-side-chat"),
            rootNodeId: sideChatRootNodeId,
            activeAttemptId: null,
            status: "waiting",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
        {
          ...event,
          id: EventId.make("event:checkpoint-capture-side-chat:node"),
          type: "node.updated",
          runId: sideChatRunId,
          nodeId: sideChatRootNodeId,
          payload: {
            id: sideChatRootNodeId,
            threadId: sideChatThreadId,
            runId: sideChatRunId,
            parentNodeId: null,
            rootNodeId: sideChatRootNodeId,
            kind: "root_turn",
            status: "waiting",
            countsForRun: true,
            providerThreadId: sideChatProviderThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: sideChatScopeId,
            startedAt: now,
            completedAt: null,
          },
        },
        {
          ...event,
          id: EventId.make("event:checkpoint-capture-side-chat:scope"),
          type: "checkpoint-scope.created",
          runId: sideChatRunId,
          nodeId: sideChatRootNodeId,
          payload: {
            id: sideChatScopeId,
            threadId: sideChatThreadId,
            runId: sideChatRunId,
            nodeId: sideChatRootNodeId,
            parentScopeId: null,
            providerThreadId: sideChatProviderThreadId,
            kind: "root_run",
            ordinalWithinParent: 0,
            advancesAppRunCount: true,
            cwd: "/repo",
            createdAt: now,
          },
        },
      ];
      yield* Effect.forEach(events, (candidate) => projectionStore.apply(candidate));
      const gitUnavailable = () => Effect.die("side chats must not snapshot the shared worktree");
      const layerCapture = CheckpointCaptureService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            CheckpointService.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  IdAllocator.layer,
                  NodeCrypto.layer,
                  Layer.mock(CheckpointStore.CheckpointStore)({
                    isGitRepository: gitUnavailable,
                    captureCheckpoint: gitUnavailable,
                    hasCheckpointRef: gitUnavailable,
                  }),
                ),
              ),
            ),
            Layer.mock(EventSink.EventSinkV2)({
              commitCommand: (input) =>
                Effect.forEach(input.events, (committed) => projectionStore.apply(committed)).pipe(
                  Effect.as({ committed: true } as never),
                  Effect.orDie,
                ),
            }),
          ),
        ),
      );

      yield* CheckpointCaptureService.CheckpointCaptureServiceV2.use((service) =>
        service.execute({
          threadId: sideChatThreadId,
          runId: sideChatRunId,
          scopeId: sideChatScopeId,
        }),
      ).pipe(Effect.provide(layerCapture));

      const { checkpoints, runs } = yield* projectionStore.getThreadRecords(sideChatThreadId, [
        "runs",
        "checkpoints",
      ]);
      assert.equal(runs[0]?.status, "completed");
      const checkpoint = checkpoints.find((candidate) => candidate.id === runs[0]?.checkpointId);
      assert.equal(checkpoint?.status, "missing");
    }),
  );
});

