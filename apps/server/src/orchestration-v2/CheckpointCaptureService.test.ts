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
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { VcsProcessTimeoutError } from "@t3tools/contracts";
import { CheckpointServiceV2, layer as checkpointServiceLayer } from "./CheckpointService.ts";
import * as CheckpointCaptureService from "./CheckpointCaptureService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const ProjectionStoreTestLayer = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
  SqlitePersistenceMemory,
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

it.layer(ProjectionStoreTestLayer)("CheckpointCaptureServiceV2", (it) => {
  it.effect.each([false, true])(
    "captures without decoding history or losing newer delegated completion, ref lookup fails=%s",
    (refLookupFails) =>
      Effect.gen(function* () {
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const later = DateTime.add(now, { seconds: 1 });

        const staleDelegatedCompletion = {
          disposition: "open" as const,
          nextGeneration: 1,
          delivery: null,
        };
        const newerCohort = {
          disposition: "open" as const,
          nextGeneration: 2,
          delivery: {
            generation: 1,
            messageId: deliveryMessageId,
            taskIds: [taskId],
          },
        };
        const staleRun: OrchestrationV2Run = {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make("message:checkpoint-capture-user"),
          rootNodeId,
          activeAttemptId: null,
          status: "waiting",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
          // Snapshot taken before a concurrent cohort advanced during capture work.
          delegatedCompletion: staleDelegatedCompletion,
        };
        const rootNode = {
          id: rootNodeId,
          threadId,
          runId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn" as const,
          status: "waiting" as const,
          countsForRun: true,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: scopeId,
          startedAt: now,
          completedAt: null,
        };
        const scope = {
          id: scopeId,
          threadId,
          runId,
          nodeId: rootNodeId,
          parentScopeId: null,
          providerThreadId,
          kind: "root_run" as const,
          ordinalWithinParent: 0,
          advancesAppRunCount: true,
          cwd: "/repo",
          createdAt: now,
        };
        const providerThread = {
          id: providerThreadId,
          driver,
          providerInstanceId,
          providerSessionId: null,
          appThreadId: threadId,
          ownerNodeId: rootNodeId,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle" as const,
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        };
        const readyBaseline = {
          id: CheckpointId.make("checkpoint:baseline-0"),
          threadId,
          scopeId,
          runId: null,
          nodeId: rootNodeId,
          parentCheckpointId: null,
          ordinalWithinScope: 0,
          appRunOrdinal: null,
          ref: CheckpointRef.make("checkpoint-ref:baseline-0"),
          status: "ready" as const,
          files: [],
          capturedAt: now,
        };
        const captured = {
          id: CheckpointId.make("checkpoint:captured-1"),
          threadId,
          scopeId,
          runId,
          nodeId: rootNodeId,
          parentCheckpointId: readyBaseline.id,
          ordinalWithinScope: 1,
          appRunOrdinal: 1,
          ref: CheckpointRef.make("checkpoint-ref:captured-1"),
          status: "ready" as const,
          files: [],
          capturedAt: now,
        };

        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-capture:thread"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId,
            title: "Checkpoint capture delegated completion",
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
              rootThreadId: threadId,
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
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-capture:run-stale"),
          type: "run.updated",
          threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId,
          occurredAt: now,
          payload: staleRun,
        });
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-capture:node"),
          type: "node.updated",
          threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId,
          occurredAt: now,
          payload: rootNode,
        });
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-capture:provider-thread"),
          type: "provider-thread.updated",
          threadId,
          nodeId: rootNodeId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: providerThread,
        });
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-capture:scope"),
          type: "checkpoint-scope.created",
          threadId,
          runId,
          nodeId: rootNodeId,
          occurredAt: now,
          payload: scope,
        });
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-capture:baseline"),
          type: "checkpoint.captured",
          threadId,
          nodeId: rootNodeId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: readyBaseline,
        });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT OR REPLACE INTO orchestration_v2_projection_turn_items
          (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json)
          VALUES ('obsolete-history', ${threadId}, ${runId}, ${rootNodeId}, NULL, NULL,
            NULL, 1, 'assistant_message', 'completed', ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
        yield* sql`UPDATE orchestration_v2_projection_checkpoints
          SET payload_json = json_set(payload_json, '$.files', 'obsolete file summary')
          WHERE checkpoint_id = ${readyBaseline.id}`;
        assert.equal(
          (yield* Effect.exit(projectionStore.getThreadProjection(threadId)))._tag,
          "Failure",
        );

        const committed = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
        const captureLayer = CheckpointCaptureService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              refLookupFails
                ? checkpointServiceLayer.pipe(
                    Layer.provide(
                      Layer.mergeAll(
                        IdAllocator.layer,
                        Layer.mock(CheckpointStore.CheckpointStore)({
                          isGitRepository: () => Effect.succeed(true),
                          captureCheckpoint: () => Effect.void,
                          hasCheckpointRef: () =>
                            Effect.fail(
                              new VcsProcessTimeoutError({
                                operation: "test.hasCheckpointRef",
                                command: "git",
                                cwd: "/repo",
                                timeoutMs: 30000,
                              }),
                            ),
                        }),
                      ),
                    ),
                  )
                : Layer.mock(CheckpointServiceV2)({
                    materializeBaselineCheckpoint: () =>
                      Effect.die(
                        "baseline materialization must be skipped when ordinal 0 is ready",
                      ),
                    capture: () => Effect.succeed(captured),
                  }),
              Layer.mock(EventSinkV2)({
                commitCommand: (input) =>
                  Ref.set(committed, input.events).pipe(
                    Effect.as({
                      commandId: input.commandId,
                      committed: true,
                      sequence: 1,
                      events: input.events,
                      effects: [],
                    } as never),
                  ),
              }),
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const service = yield* CheckpointCaptureService.CheckpointCaptureServiceV2;
          const incomplete = yield* service
            .execute({ threadId, runId, scopeId: CheckpointScopeId.make("missing-scope") })
            .pipe(Effect.flip);
          assert.instanceOf(incomplete, CheckpointCaptureService.CheckpointCaptureExecutionError);
          // Capture reads the waiting run while the projection still holds the stale cohort.
          yield* service.execute({ threadId, runId, scopeId });

          const events = yield* Ref.get(committed);
          const runUpdated = events.find((event) => event.type === "run.updated");
          assert.isDefined(runUpdated);
          if (runUpdated?.type !== "run.updated") {
            return;
          }
          assert.equal(runUpdated.payload.status, "completed");
          const capturedEvent = events.find((event) => event.type === "checkpoint.captured");
          assert.equal(
            runUpdated.payload.checkpointId,
            refLookupFails ? capturedEvent?.payload.id : captured.id,
          );
          if (refLookupFails && capturedEvent?.type === "checkpoint.captured") {
            assert.equal(capturedEvent.payload.status, "ready");
            assert.deepEqual(capturedEvent.payload.files, []);
          }
          assert.isUndefined(
            runUpdated.payload.delegatedCompletion,
            "checkpoint capture must omit delegatedCompletion so ProjectionStore can keep a newer cohort",
          );

          // Race: a newer cohort lands on the projection after capture read the stale
          // waiting run and before the capture command's run.updated is applied.
          yield* projectionStore.apply({
            id: EventId.make("event:checkpoint-capture:newer-cohort"),
            type: "run.updated",
            threadId,
            runId,
            nodeId: rootNodeId,
            providerInstanceId,
            occurredAt: later,
            payload: {
              ...staleRun,
              delegatedCompletion: newerCohort,
            },
          });

          // Apply the real capture-emitted run.updated through ProjectionStore.
          yield* projectionStore.apply(runUpdated);

          const projectedRun = (yield* projectionStore.getCheckpointCaptureContext(threadId, {
            runId,
            scopeId,
          })).run;
          assert.isDefined(projectedRun);
          assert.equal(projectedRun?.status, "completed");
          assert.equal(projectedRun?.checkpointId, runUpdated.payload.checkpointId);
          assert.deepEqual(projectedRun?.delegatedCompletion, newerCohort);
          assert.equal(projectedRun?.delegatedCompletion?.delivery?.messageId, deliveryMessageId);
          assert.deepEqual(projectedRun?.delegatedCompletion?.delivery?.taskIds, [taskId]);
          // The persisted completion is the at-least-once capture receipt.
          yield* Ref.set(committed, []);
          yield* service.execute({ threadId, runId, scopeId });
          assert.deepEqual(yield* Ref.get(committed), []);
        }).pipe(Effect.provide(captureLayer));
      }),
  );

  // Capture and rollback share the thread's effect lane, so a rollback can only
  // commit before a capture runs: while it waits out a retry, or when a restart
  // requeues it behind a pending rollback. It must not revive the run.
  it.effect("does not capture a stopped run that a rollback already discarded", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const stoppedThreadId = ThreadId.make("thread:checkpoint-capture-rolled-back");
      const stoppedRunId = RunId.make("run:checkpoint-capture-rolled-back");
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-rolled-back:thread"),
        type: "thread.created",
        threadId: stoppedThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: stoppedThreadId,
          projectId,
          title: "Checkpoint capture after rollback",
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
            rootThreadId: stoppedThreadId,
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
      const stoppedRun: OrchestrationV2Run = {
        id: stoppedRunId,
        threadId: stoppedThreadId,
        ordinal: 2,
        providerInstanceId,
        modelSelection,
        providerThreadId,
        userMessageId: MessageId.make("message:checkpoint-capture-rolled-back"),
        rootNodeId,
        activeAttemptId: null,
        status: "interrupted",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      };
      // The rollback's write, which landed before the capture ran.
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-rolled-back:run"),
        type: "run.updated",
        threadId: stoppedThreadId,
        runId: stoppedRunId,
        providerInstanceId,
        occurredAt: now,
        payload: { ...stoppedRun, status: "rolled_back" },
      });

      const committed = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
      const captureLayer = CheckpointCaptureService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            Layer.mock(CheckpointServiceV2)({
              materializeBaselineCheckpoint: () => Effect.die("a discarded run has no baseline"),
              capture: () => Effect.die("a discarded run must not be captured"),
            }),
            Layer.mock(EventSinkV2)({
              commitCommand: (input) =>
                Ref.set(committed, input.events).pipe(Effect.as({ committed: true } as never)),
            }),
          ),
        ),
      );

      // Settles without retrying, and commits nothing that would revive the run.
      yield* CheckpointCaptureService.CheckpointCaptureServiceV2.pipe(
        Effect.flatMap((service) =>
          service.execute({ threadId: stoppedThreadId, runId: stoppedRunId, scopeId }),
        ),
        Effect.provide(captureLayer),
      );

      assert.deepEqual(yield* Ref.get(committed), []);
      const projected = yield* projectionStore.getCheckpointCaptureContext(stoppedThreadId, {
        runId: stoppedRunId,
        scopeId,
      });
      assert.equal(projected.run?.status, "rolled_back");
      assert.isNull(projected.run?.checkpointId ?? null);
    }),
  );

  // A cancelled run's checkpoint is the rollback point for the message after
  // it, so capture records it without reporting the run as completed.
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
      // The turn runs, then finalizes as cancelled the way RunExecutionService
      // writes it, which also enqueues this capture.
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
      const captureLayer = CheckpointCaptureService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            Layer.mock(CheckpointServiceV2)({
              materializeBaselineCheckpoint: () =>
                Effect.die("baseline materialization must be skipped when ordinal 0 is ready"),
              capture: () => Effect.succeed(captured),
            }),
            // Commit straight into the projection so the test reads what a
            // client would see after the capture lands.
            Layer.mock(EventSinkV2)({
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
        // A redelivered effect finds the recorded checkpoint and commits nothing.
        yield* service.execute({
          threadId: cancelledThreadId,
          runId: cancelledRunId,
          scopeId: cancelledScopeId,
        });
      }).pipe(Effect.provide(captureLayer));

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
});
