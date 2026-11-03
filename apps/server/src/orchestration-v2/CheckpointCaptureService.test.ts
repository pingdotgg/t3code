import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
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
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { VcsProcessTimeoutError } from "@t3tools/contracts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CheckpointCaptureService from "./CheckpointCaptureService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";

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
        const layerCapture = CheckpointCaptureService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              NodeServices.layer,
              Layer.mock(ProjectStore.ProjectStoreV2)({}),
              refLookupFails
                ? CheckpointService.layer.pipe(
                    Layer.provide(
                      Layer.mergeAll(
                        IdAllocator.layer,
                        NodeCrypto.layer,
                        NodeServices.layer,
                        Layer.mock(CheckpointStore.CheckpointStore)({
                          listAuthoredPaths: () => Effect.succeed(null),
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
                : Layer.mock(CheckpointService.CheckpointServiceV2)({
                    materializeBaselineCheckpoint: () =>
                      Effect.die(
                        "baseline materialization must be skipped when ordinal 0 is ready",
                      ),
                    capture: () => Effect.succeed(captured),
                  }),
              Layer.mock(EventSink.EventSinkV2)({
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
          yield* Ref.set(committed, []);
          yield* service.execute({ threadId, runId, scopeId });
          assert.deepEqual(yield* Ref.get(committed), []);
        }).pipe(Effect.provide(layerCapture));
      }),
  );

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
      const layerCapture = CheckpointCaptureService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            NodeServices.layer,
            Layer.mock(ProjectStore.ProjectStoreV2)({}),
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              materializeBaselineCheckpoint: () => Effect.die("a discarded run has no baseline"),
              capture: () => Effect.die("a discarded run must not be captured"),
            }),
            Layer.mock(EventSink.EventSinkV2)({
              commitCommand: (input) =>
                Ref.set(committed, input.events).pipe(Effect.as({ committed: true } as never)),
            }),
          ),
        ),
      );

      yield* CheckpointCaptureService.CheckpointCaptureServiceV2.pipe(
        Effect.flatMap((service) =>
          service.execute({ threadId: stoppedThreadId, runId: stoppedRunId, scopeId }),
        ),
        Effect.provide(layerCapture),
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

  // A stopped run is captured after it ends; by then the next root run, dispatched or queued, may
  // have re-created the thread's one root scope with its own node and time.
  it.effect.each([1, 2])(
    "attributes the baselines a late capture materializes to the stopped run %i",
    (ordinal) =>
      Effect.gen(function* () {
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const requestedAt = yield* DateTime.now;
        const stoppedAt = DateTime.add(requestedAt, { seconds: 1 });
        const rescopedAt = DateTime.add(requestedAt, { seconds: 2 });
        const lateThreadId = ThreadId.make(`thread:checkpoint-capture-late-${ordinal}`);
        const lateRunId = RunId.make(`run:checkpoint-capture-late-${ordinal}`);
        const lateRootNodeId = NodeId.make(`node:checkpoint-capture-late-${ordinal}-root`);
        const lateScopeId = CheckpointScopeId.make(`scope:checkpoint-capture-late-${ordinal}`);
        const lateProviderThreadId = ProviderThreadId.make(
          `provider-thread:checkpoint-capture-late-${ordinal}`,
        );
        yield* projectionStore.apply({
          id: EventId.make(`event:checkpoint-capture-late-${ordinal}:thread`),
          type: "thread.created",
          threadId: lateThreadId,
          occurredAt: requestedAt,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: lateThreadId,
            projectId,
            title: "Checkpoint capture after the next run re-created the scope",
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
              rootThreadId: lateThreadId,
            },
            forkedFrom: null,
            createdAt: requestedAt,
            updatedAt: requestedAt,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
        yield* projectionStore.apply({
          id: EventId.make(`event:checkpoint-capture-late-${ordinal}:run`),
          type: "run.updated",
          threadId: lateThreadId,
          runId: lateRunId,
          nodeId: lateRootNodeId,
          providerInstanceId,
          occurredAt: stoppedAt,
          payload: {
            id: lateRunId,
            threadId: lateThreadId,
            ordinal,
            providerInstanceId,
            modelSelection,
            providerThreadId: lateProviderThreadId,
            userMessageId: MessageId.make(`message:checkpoint-capture-late-${ordinal}`),
            rootNodeId: lateRootNodeId,
            activeAttemptId: null,
            status: "interrupted",
            requestedAt,
            startedAt: requestedAt,
            completedAt: stoppedAt,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
        yield* projectionStore.apply({
          id: EventId.make(`event:checkpoint-capture-late-${ordinal}:node`),
          type: "node.updated",
          threadId: lateThreadId,
          runId: lateRunId,
          nodeId: lateRootNodeId,
          providerInstanceId,
          occurredAt: stoppedAt,
          payload: {
            id: lateRootNodeId,
            threadId: lateThreadId,
            runId: lateRunId,
            parentNodeId: null,
            rootNodeId: lateRootNodeId,
            kind: "root_turn",
            status: "interrupted",
            countsForRun: true,
            providerThreadId: lateProviderThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: lateScopeId,
            startedAt: requestedAt,
            completedAt: stoppedAt,
          },
        });
        yield* projectionStore.apply({
          id: EventId.make(`event:checkpoint-capture-late-${ordinal}:provider-thread`),
          type: "provider-thread.updated",
          threadId: lateThreadId,
          nodeId: lateRootNodeId,
          driver,
          providerInstanceId,
          occurredAt: requestedAt,
          payload: {
            id: lateProviderThreadId,
            driver,
            providerInstanceId,
            providerSessionId: null,
            appThreadId: lateThreadId,
            ownerNodeId: lateRootNodeId,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: ordinal,
            handoffIds: [],
            forkedFrom: null,
            createdAt: requestedAt,
            updatedAt: requestedAt,
          },
        });
        const nextRunId = RunId.make(`run:checkpoint-capture-late-${ordinal}-next`);
        const nextRootNodeId = NodeId.make(`node:checkpoint-capture-late-${ordinal}-next-root`);
        yield* projectionStore.apply({
          id: EventId.make(`event:checkpoint-capture-late-${ordinal}:scope-of-next-run`),
          type: "checkpoint-scope.created",
          threadId: lateThreadId,
          runId: nextRunId,
          nodeId: nextRootNodeId,
          occurredAt: rescopedAt,
          payload: {
            id: lateScopeId,
            threadId: lateThreadId,
            runId: nextRunId,
            nodeId: nextRootNodeId,
            parentScopeId: null,
            providerThreadId: lateProviderThreadId,
            kind: "root_run",
            ordinalWithinParent: 0,
            advancesAppRunCount: true,
            cwd: "/repo",
            createdAt: rescopedAt,
          },
        });

        const committed = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
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
                      isGitRepository: () => Effect.succeed(true),
                      hasCheckpointRef: () => Effect.succeed(true),
                      captureCheckpoint: () => Effect.void,
                      diffCheckpoints: () => Effect.succeed(""),
                      listAuthoredPaths: () => Effect.succeed(null),
                    }),
                  ),
                ),
              ),
              Layer.mock(EventSink.EventSinkV2)({
                commitCommand: (input) =>
                  Ref.set(committed, input.events).pipe(Effect.as({ committed: true } as never)),
              }),
            ),
          ),
        );
        yield* CheckpointCaptureService.CheckpointCaptureServiceV2.use((service) =>
          service.execute({ threadId: lateThreadId, runId: lateRunId, scopeId: lateScopeId }),
        ).pipe(Effect.provide(layerCapture));

        const baselines = (yield* Ref.get(committed)).flatMap((event) =>
          event.type === "checkpoint.captured" && event.payload.runId === null ? [event] : [],
        );
        assert.deepEqual(
          baselines.map((event) => event.payload.ordinalWithinScope),
          ordinal === 1 ? [0] : [0, 1],
        );
        for (const baseline of baselines) {
          assert.equal(baseline.nodeId, lateRootNodeId);
          assert.equal(baseline.payload.nodeId, lateRootNodeId);
          assert.deepEqual(baseline.payload.capturedAt, requestedAt);
        }
      }),
  );

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
            NodeServices.layer,
            Layer.mock(ProjectStore.ProjectStoreV2)({}),
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
            NodeServices.layer,
            Layer.mock(ProjectStore.ProjectStoreV2)({}),
            CheckpointService.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  IdAllocator.layer,
                  NodeCrypto.layer,
                  NodeServices.layer,
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

  it.effect(
    "completes a server compaction run with a missing checkpoint and never captures the shared worktree",
    () =>
      Effect.gen(function* () {
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const compactionThreadId = ThreadId.make("thread:checkpoint-capture-server-compaction");
        const compactionRunId = RunId.make("run:checkpoint-capture-server-compaction");
        const compactionScopeId = CheckpointScopeId.make(
          "scope:checkpoint-capture-server-compaction",
        );
        const compactionRootNodeId = NodeId.make("node:checkpoint-capture-server-compaction-root");
        const compactionProviderThreadId = ProviderThreadId.make(
          "provider-thread:checkpoint-capture-server-compaction",
        );
        const event = { threadId: compactionThreadId, occurredAt: now };
        const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
          {
            ...event,
            id: EventId.make("event:checkpoint-capture-server-compaction:thread"),
            type: "thread.created",
            payload: {
              createdBy: "user",
              creationSource: "web",
              id: compactionThreadId,
              projectId,
              title: "Pipeline step",
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
            id: EventId.make("event:checkpoint-capture-server-compaction:provider-thread"),
            type: "provider-thread.updated",
            driver,
            providerInstanceId,
            payload: {
              id: compactionProviderThreadId,
              driver,
              providerInstanceId,
              providerSessionId: null,
              appThreadId: compactionThreadId,
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
            id: EventId.make("event:checkpoint-capture-server-compaction:message"),
            type: "message.updated",
            payload: {
              id: MessageId.make("message:checkpoint-capture-server-compaction"),
              threadId: compactionThreadId,
              runId: null,
              nodeId: null,
              role: "user",
              text: "/compact",
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "server",
              idleCompaction: "beforeCacheExpires",
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            ...event,
            id: EventId.make("event:checkpoint-capture-server-compaction:run"),
            type: "run.updated",
            runId: compactionRunId,
            payload: {
              id: compactionRunId,
              threadId: compactionThreadId,
              ordinal: 1,
              providerInstanceId,
              modelSelection,
              providerThreadId: compactionProviderThreadId,
              userMessageId: MessageId.make("message:checkpoint-capture-server-compaction"),
              rootNodeId: compactionRootNodeId,
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
            id: EventId.make("event:checkpoint-capture-server-compaction:node"),
            type: "node.updated",
            runId: compactionRunId,
            nodeId: compactionRootNodeId,
            payload: {
              id: compactionRootNodeId,
              threadId: compactionThreadId,
              runId: compactionRunId,
              parentNodeId: null,
              rootNodeId: compactionRootNodeId,
              kind: "root_turn",
              status: "waiting",
              countsForRun: true,
              providerThreadId: compactionProviderThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: compactionScopeId,
              startedAt: now,
              completedAt: null,
            },
          },
          {
            ...event,
            id: EventId.make("event:checkpoint-capture-server-compaction:scope"),
            type: "checkpoint-scope.created",
            runId: compactionRunId,
            nodeId: compactionRootNodeId,
            payload: {
              id: compactionScopeId,
              threadId: compactionThreadId,
              runId: compactionRunId,
              nodeId: compactionRootNodeId,
              parentScopeId: null,
              providerThreadId: compactionProviderThreadId,
              kind: "root_run",
              ordinalWithinParent: 0,
              advancesAppRunCount: true,
              cwd: "/repo",
              createdAt: now,
            },
          },
        ];
        yield* Effect.forEach(events, (candidate) => projectionStore.apply(candidate));
        const gitUnavailable = () =>
          Effect.die("a server compaction must not snapshot the shared worktree");
        const layerCapture = CheckpointCaptureService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              NodeServices.layer,
              Layer.mock(ProjectStore.ProjectStoreV2)({}),
              CheckpointService.layer.pipe(
                Layer.provide(
                  Layer.mergeAll(
                    IdAllocator.layer,
                    NodeCrypto.layer,
                    NodeServices.layer,
                    Layer.mock(CheckpointStore.CheckpointStore)({
                      isGitRepository: () => Effect.succeed(true),
                      captureCheckpoint: gitUnavailable,
                      hasCheckpointRef: () => Effect.succeed(false),
                    }),
                  ),
                ),
              ),
              Layer.mock(EventSink.EventSinkV2)({
                commitCommand: (input) =>
                  Effect.forEach(input.events, (committed) =>
                    projectionStore.apply(committed),
                  ).pipe(Effect.as({ committed: true } as never), Effect.orDie),
              }),
            ),
          ),
        );

        yield* CheckpointCaptureService.CheckpointCaptureServiceV2.use((service) =>
          service.execute({
            threadId: compactionThreadId,
            runId: compactionRunId,
            scopeId: compactionScopeId,
          }),
        ).pipe(Effect.provide(layerCapture));

        const { checkpoints, runs } = yield* projectionStore.getThreadRecords(compactionThreadId, [
          "runs",
          "checkpoints",
        ]);
        assert.equal(runs[0]?.status, "completed");
        const checkpoint = checkpoints.find((candidate) => candidate.id === runs[0]?.checkpointId);
        assert.equal(checkpoint?.status, "missing");
      }),
  );
});

const layerVcsProcessTest = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const layerCheckpointServiceTest = CheckpointService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      CheckpointStore.layer.pipe(
        Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(layerVcsProcessTest))),
        Layer.provide(NodeServices.layer),
      ),
      IdAllocator.layer,
      NodeServices.layer,
    ).pipe(Layer.provideMerge(NodeCrypto.layer)),
  ),
);
const layerMultiRepoTest = Layer.mergeAll(
  layerProjectionStoreTest,
  layerCheckpointServiceTest,
  layerVcsProcessTest,
  IdAllocator.layer,
  NodeServices.layer,
).pipe(Layer.provideMerge(NodeCrypto.layer));

/**
 * A run in a plain home folder that tracks two child repos (`api`, `web`), with an untracked
 * sibling repo beside home. Baselines are taken the way run start takes them.
 */
const seedPlainHomeRun = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const checkpoints = yield* CheckpointService.CheckpointServiceV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const now = yield* DateTime.now;
  const parent = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-capture-multi-repo-" }),
  );
  const home = path.join(parent, "home");
  const git = (cwd: string, args: ReadonlyArray<string>) =>
    vcsProcess
      .run({ operation: "CheckpointCaptureService.test.git", command: "git", cwd, args })
      .pipe(Effect.map((result) => result.stdout.trim()));
  for (const repository of [
    path.join(home, "api"),
    path.join(home, "web"),
    path.join(parent, "other"),
  ]) {
    yield* fileSystem.makeDirectory(repository, { recursive: true });
    yield* git(repository, ["init", "--quiet"]);
    yield* git(repository, ["config", "user.email", "test@test.com"]);
    yield* git(repository, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(path.join(repository, "README.md"), "# initial\n");
    yield* git(repository, ["add", "."]);
    yield* git(repository, ["commit", "--quiet", "-m", "initial"]);
  }
  yield* fileSystem.writeFileString(path.join(home, "notes.md"), "plain home\n");

  const threadId = ThreadId.make("thread:capture-multi-repo");
  const multiRepoProjectId = ProjectId.make("project:capture-multi-repo");
  const multiRepoRunId = RunId.make("run:capture-multi-repo");
  const nodeId = NodeId.make("node:capture-multi-repo");
  const multiRepoProviderThreadId = ProviderThreadId.make("provider-thread:capture-multi-repo");
  const run: OrchestrationV2Run = {
    id: multiRepoRunId,
    threadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection,
    providerThreadId: multiRepoProviderThreadId,
    userMessageId: MessageId.make("message:capture-multi-repo"),
    rootNodeId: nodeId,
    activeAttemptId: null,
    status: "waiting",
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const rootScope = yield* checkpoints.prepareRootRunScope({
    threadId,
    runId: multiRepoRunId,
    rootNodeId: nodeId,
    providerThreadId: multiRepoProviderThreadId,
    cwd: home,
    createdAt: now,
  });
  const repositoryScopes = yield* checkpoints.prepareRepositoryScopes({
    rootScope,
    repositories: ["api", "web"].map((name) => ({
      name,
      cwd: path.join(home, name),
      originalPath: path.join(home, name),
    })),
  });
  let sequence = 0;
  const apply = (event: Omit<OrchestrationV2DomainEvent, "id" | "threadId" | "occurredAt">) =>
    projectionStore.apply({
      ...event,
      id: EventId.make(`event:capture-multi-repo:${sequence++}`),
      threadId,
      occurredAt: now,
    } as OrchestrationV2DomainEvent);
  yield* apply({
    type: "thread.created",
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: multiRepoProjectId,
      title: "Multi-repo capture",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
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
  yield* apply({ type: "run.updated", runId: multiRepoRunId, payload: run });
  const rootNode = {
    id: nodeId,
    threadId,
    runId: multiRepoRunId,
    parentNodeId: null,
    rootNodeId: nodeId,
    kind: "root_turn" as const,
    status: "waiting" as const,
    countsForRun: true,
    providerThreadId: multiRepoProviderThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: rootScope.id,
    startedAt: now,
    completedAt: null,
  };
  yield* apply({ type: "node.updated", runId: multiRepoRunId, payload: rootNode });
  yield* apply({
    type: "provider-thread.updated",
    driver,
    payload: {
      id: multiRepoProviderThreadId,
      driver,
      providerInstanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: nodeId,
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
  for (const scope of [rootScope, ...repositoryScopes]) {
    yield* apply({ type: "checkpoint-scope.created", runId: multiRepoRunId, payload: scope });
    yield* checkpoints.captureBaseline({
      scope,
      ordinalWithinScope: 0,
      ...(scope === rootScope ? { repositoryScopes } : {}),
    });
  }

  // The turn edits both repos, an untracked sibling repo and a plain file in home.
  yield* fileSystem.writeFileString(path.join(home, "api", "README.md"), "# api edit\n");
  yield* fileSystem.makeDirectory(path.join(home, "web", "src"));
  yield* fileSystem.writeFileString(path.join(home, "web", "src", "app.ts"), "export {};\n");
  yield* fileSystem.writeFileString(path.join(parent, "other", "x.ts"), "export {};\n");
  yield* fileSystem.writeFileString(path.join(home, "notes.md"), "plain home edit\n");
  for (const [ordinal, fileName] of [
    path.join(home, "api", "README.md"),
    "web/src/app.ts",
    path.join(parent, "other", "x.ts"),
    "notes.md",
  ].entries()) {
    yield* apply({
      type: "turn-item.updated",
      runId: multiRepoRunId,
      payload: {
        id: TurnItemId.make(`turn-item:capture-multi-repo:${ordinal}`),
        threadId,
        runId: multiRepoRunId,
        nodeId,
        providerThreadId: multiRepoProviderThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 100 + ordinal,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "file_change",
        fileName,
      },
    });
  }

  const committed: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const failNextCommit = yield* Ref.make(false);
  const captureLayer = CheckpointCaptureService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(CheckpointService.CheckpointServiceV2, checkpoints),
        Layer.succeed(IdAllocator.IdAllocatorV2, ids),
        Layer.succeed(ProjectionStore.ProjectionStoreV2, projectionStore),
        NodeServices.layer,
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () =>
            Effect.succeedSome({
              workspaceRoot: home,
              trackedFolders: ["api", "web"].map((name) => ({ name, path: path.join(home, name) })),
            } as never),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) =>
            Effect.gen(function* () {
              if (yield* Ref.getAndSet(failNextCommit, false)) {
                return yield* Effect.die("commit failed");
              }
              for (const event of input.events)
                yield* projectionStore.apply(event).pipe(Effect.orDie);
              committed.push(input.events);
              return { committed: true } as never;
            }),
        }),
      ),
    ),
  );
  const capture = CheckpointCaptureService.CheckpointCaptureServiceV2.pipe(
    Effect.flatMap((service) =>
      service.execute({ threadId, runId: multiRepoRunId, scopeId: rootScope.id }),
    ),
    Effect.provide(captureLayer),
  );
  /** Starts run 2 the way run start does, and returns its capture. */
  const startNextRun = Effect.gen(function* () {
    const nextRunId = RunId.make("run:capture-multi-repo:2");
    const nextNodeId = NodeId.make("node:capture-multi-repo:2");
    yield* apply({
      type: "run.updated",
      runId: nextRunId,
      payload: {
        ...run,
        id: nextRunId,
        ordinal: 2,
        userMessageId: MessageId.make("message:capture-multi-repo:2"),
        rootNodeId: nextNodeId,
      },
    });
    yield* apply({
      type: "node.updated",
      runId: nextRunId,
      payload: { ...rootNode, id: nextNodeId, runId: nextRunId, rootNodeId: nextNodeId },
    });
    for (const scope of repositoryScopes) {
      yield* apply({
        type: "checkpoint-scope.created",
        runId: nextRunId,
        payload: { ...scope, runId: nextRunId },
      });
    }
    for (const scope of [rootScope, ...repositoryScopes]) {
      yield* checkpoints.captureBaseline({
        scope,
        ordinalWithinScope: 1,
        ...(scope === rootScope ? { repositoryScopes } : {}),
      });
    }
    yield* fileSystem.writeFileString(path.join(home, "api", "README.md"), "# api second edit\n");
    return yield* CheckpointCaptureService.CheckpointCaptureServiceV2.pipe(
      Effect.flatMap((service) =>
        service.execute({ threadId, runId: nextRunId, scopeId: rootScope.id }),
      ),
      Effect.provide(captureLayer),
    );
  });
  return {
    parent,
    home,
    threadId,
    rootScope,
    repositoryScopes,
    committed,
    failNextCommit,
    capture,
    startNextRun,
    git,
  };
});

it.layer(layerMultiRepoTest)("CheckpointCaptureServiceV2 multi-repo", (it) => {
  it.effect("keeps each turn's record in a plain home folder when the next run captures", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const run = yield* seedPlainHomeRun;
      yield* run.capture;
      yield* run.startNextRun;

      // A plain home has no Git, so no baseline record may replace turn 1's root checkpoint.
      const { checkpoints } = yield* projectionStore.getCheckpointContext(run.threadId);
      const firstTurn = checkpoints.find(
        (checkpoint) =>
          checkpoint.scopeId === run.rootScope.id && checkpoint.ordinalWithinScope === 1,
      );
      assert.deepEqual(
        { runId: firstTurn?.runId, appRunOrdinal: firstTurn?.appRunOrdinal },
        { runId: RunId.make("run:capture-multi-repo"), appRunOrdinal: 1 },
      );
      const secondRun = (run.committed.at(-1) ?? []).flatMap((event) =>
        event.type === "checkpoint.captured" ? [event.payload] : [],
      );
      assert.deepEqual(
        secondRun
          .filter((checkpoint) => checkpoint.scopeId === run.rootScope.id)
          .map((checkpoint) => checkpoint.ordinalWithinScope),
        [2],
      );
      assert.deepEqual(
        secondRun
          .find(
            (checkpoint) =>
              checkpoint.scopeId === run.repositoryScopes[0]?.id &&
              checkpoint.ordinalWithinScope === 2,
          )
          ?.files.map((file) => file.path),
        ["README.md"],
      );
    }),
  );

  it.effect("captures each tracked repo of a plain home folder and diffs them per repo", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const run = yield* seedPlainHomeRun;
      yield* run.capture;

      const checkpoints = run.committed
        .flat()
        .flatMap((event) => (event.type === "checkpoint.captured" ? [event.payload] : []));
      const root = checkpoints.find(
        (checkpoint) => checkpoint.scopeId === run.rootScope.id && checkpoint.runId !== null,
      );
      assert.equal(root?.status, "missing");
      assert.equal(root?.appRunOrdinal, 1);
      assert.deepEqual(root?.outsideEdits, [
        {
          root: path.join(run.parent, "other"),
          name: "other",
          tracked: false,
          files: ["x.ts"],
          fileCount: 1,
        },
      ]);
      assert.deepEqual(
        run.repositoryScopes.map((scope) => {
          const captured = checkpoints.filter((checkpoint) => checkpoint.scopeId === scope.id);
          return {
            label: scope.label,
            records: captured.map(
              ({ ordinalWithinScope, appRunOrdinal, status, runId, files }) => ({
                ordinalWithinScope,
                appRunOrdinal,
                status,
                hasRun: runId !== null,
                files: files.map((file) => file.path),
              }),
            ),
          };
        }),
        [
          {
            label: "api",
            records: [
              {
                ordinalWithinScope: 0,
                appRunOrdinal: null,
                status: "ready",
                hasRun: false,
                files: [],
              },
              {
                ordinalWithinScope: 1,
                appRunOrdinal: null,
                status: "ready",
                hasRun: true,
                files: ["README.md"],
              },
            ],
          },
          {
            label: "web",
            records: [
              {
                ordinalWithinScope: 0,
                appRunOrdinal: null,
                status: "ready",
                hasRun: false,
                files: [],
              },
              {
                ordinalWithinScope: 1,
                appRunOrdinal: null,
                status: "ready",
                hasRun: true,
                files: ["src/app.ts"],
              },
            ],
          },
        ],
      );

      const query = yield* CheckpointDiffQuery.make.pipe(
        Effect.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getCheckpointContext: (threadId) =>
              projectionStore.getCheckpointContext(threadId).pipe(Effect.orDie),
          }),
        ),
      );
      const turn = yield* query.getTurnDiff({
        threadId: run.threadId,
        fromTurnCount: 0,
        toTurnCount: 1,
      });
      assert.equal(turn.diff, "");
      assert.deepEqual(
        turn.repositories?.map(({ name, repositoryPath, relativePath, diff }) => ({
          name,
          repositoryPath,
          relativePath,
          files: [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]),
        })),
        [
          {
            name: "api",
            repositoryPath: path.join(run.home, "api"),
            relativePath: "api",
            files: ["README.md"],
          },
          {
            name: "web",
            repositoryPath: path.join(run.home, "web"),
            relativePath: "web",
            files: ["src/app.ts"],
          },
        ],
      );
      const fullThread = yield* query.getFullThreadDiff({ threadId: run.threadId, toTurnCount: 1 });
      assert.deepEqual(fullThread.repositories, turn.repositories);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps refs a failed capture already wrote and fills only the missing ones", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const run = yield* seedPlainHomeRun;
      const [api, web] = run.repositoryScopes;
      if (api === undefined || web === undefined) return yield* Effect.die("missing scopes");
      const ref = (scopeId: CheckpointScopeId) =>
        CheckpointService.checkpointRefForScopeOrdinal({ scopeId, ordinalWithinScope: 1 });

      yield* Ref.set(run.failNextCommit, true);
      yield* run.capture.pipe(Effect.exit);
      assert.deepEqual(run.committed, []);
      const apiCommit = yield* run.git(api.cwd, ["rev-parse", yield* ref(api.id)]);
      // The retry finds api captured and web not, and the workspace has moved on since.
      yield* run.git(web.cwd, ["update-ref", "-d", yield* ref(web.id)]);
      yield* fileSystem.writeFileString(path.join(api.cwd, "README.md"), "# after the run\n");
      yield* fileSystem.writeFileString(path.join(web.cwd, "later.ts"), "export {};\n");

      yield* run.capture;
      assert.equal(yield* run.git(api.cwd, ["rev-parse", yield* ref(api.id)]), apiCommit);
      assert.equal(yield* run.git(api.cwd, ["show", `${apiCommit}:README.md`]), "# api edit");
      assert.deepEqual(
        (yield* run.git(web.cwd, ["ls-tree", "-r", "--name-only", yield* ref(web.id)])).split("\n"),
        ["README.md", "later.ts", "src/app.ts"],
      );
      assert.lengthOf(run.committed, 1);
    }).pipe(Effect.scoped),
  );
});
