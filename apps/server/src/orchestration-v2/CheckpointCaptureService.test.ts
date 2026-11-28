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
import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { VcsProcessTimeoutError } from "@t3tools/contracts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CheckpointCaptureService from "./CheckpointCaptureService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as WorkspaceFolders from "../workspace/WorkspaceFolders.ts";

// `git -C <cwd> -c <config> log ...` reads as `log`.
const gitSubcommand = (args: ReadonlyArray<string>) => {
  let index = 0;
  while (args[index] === "-C" || args[index] === "-c") index += 2;
  return args[index] ?? "";
};

const layerProjectionStoreTest = Layer.mergeAll(
  ThreadCommandExecutor.layer,
  ProjectionStore.layer.pipe(
    Layer.provide(NodeCrypto.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  ),
  SqlitePersistence.layerMemory,
);

const layerNoTrackedFolders = Layer.merge(
  NodeServices.layer,
  Layer.mock(WorkspaceFolders.WorkspaceFolders)({
    forThread: () => Effect.succeed({ folders: [], extraRoots: [] }),
    submodules: () => Effect.succeed([]),
  }),
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
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
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
          status: "completed" as const,
          countsForRun: true,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: scopeId,
          startedAt: now,
          completedAt: now,
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
              refLookupFails
                ? CheckpointService.layer.pipe(
                    Layer.provide(
                      Layer.mergeAll(
                        IdAllocator.layer,
                        NodeCrypto.layer,
                        layerNoTrackedFolders,
                        Layer.mock(CheckpointStore.CheckpointStore)({
                          listAuthoredPaths: () => Effect.succeed(null),
                          isGitRepository: () => Effect.succeed(true),
                          captureCheckpoint: () => Effect.succeed(null),
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
                    capturesSoFar: () => Effect.succeed(0),
                    repositoryScopes: () => Effect.succeed([]),
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
          // The run completed when its provider turn ended; capture only attaches the checkpoint.
          assert.equal(runUpdated.payload.status, "completed");
          assert.deepEqual(runUpdated.payload.completedAt, now);
          assert.isFalse(events.some((event) => event.type === "node.updated"));
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
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              repositoryScopes: () => Effect.succeed([]),
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

  // Stop can be accepted while the provider's successful terminal is being written: the run is
  // then `waiting` with a stored request and no result, and capture is what settles it.
  it.effect("ends a waiting run as interrupted when Stop was accepted before capture", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const ids = yield* IdAllocator.IdAllocatorV2;
      const now = yield* DateTime.now;
      const stopThreadId = ThreadId.make("thread:checkpoint-capture-stop-race");
      const stopRunId = RunId.make("run:checkpoint-capture-stop-race");
      const stopScopeId = CheckpointScopeId.make("scope:checkpoint-capture-stop-race");
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-stop-race:thread"),
        type: "thread.created",
        threadId: stopThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: stopThreadId,
          projectId,
          title: "Stop accepted before capture",
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
            rootThreadId: stopThreadId,
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
        id: EventId.make("event:checkpoint-capture-stop-race:run"),
        type: "run.updated",
        threadId: stopThreadId,
        runId: stopRunId,
        nodeId: rootNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: stopRunId,
          threadId: stopThreadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make("message:checkpoint-capture-stop-race"),
          rootNodeId,
          activeAttemptId: null,
          status: "waiting",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-stop-race:node"),
        type: "node.updated",
        threadId: stopThreadId,
        runId: stopRunId,
        nodeId: rootNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: rootNodeId,
          threadId: stopThreadId,
          runId: stopRunId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: "waiting",
          countsForRun: true,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: stopScopeId,
          startedAt: now,
          completedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-stop-race:provider-thread"),
        type: "provider-thread.updated",
        threadId: stopThreadId,
        nodeId: rootNodeId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          driver,
          providerInstanceId,
          providerSessionId: null,
          appThreadId: stopThreadId,
          ownerNodeId: rootNodeId,
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
        id: EventId.make("event:checkpoint-capture-stop-race:scope"),
        type: "checkpoint-scope.created",
        threadId: stopThreadId,
        runId: stopRunId,
        nodeId: rootNodeId,
        occurredAt: now,
        payload: {
          id: stopScopeId,
          threadId: stopThreadId,
          runId: stopRunId,
          nodeId: rootNodeId,
          parentScopeId: null,
          providerThreadId,
          kind: "root_run",
          ordinalWithinParent: 0,
          advancesAppRunCount: true,
          cwd: "/repo",
          createdAt: now,
        },
      });
      const baseline = {
        id: CheckpointId.make("checkpoint:stop-race-baseline-0"),
        threadId: stopThreadId,
        scopeId: stopScopeId,
        runId: null,
        nodeId: rootNodeId,
        parentCheckpointId: null,
        ordinalWithinScope: 0,
        appRunOrdinal: null,
        ref: CheckpointRef.make("checkpoint-ref:stop-race-baseline-0"),
        status: "ready" as const,
        files: [],
        capturedAt: now,
      };
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-stop-race:baseline"),
        type: "checkpoint.captured",
        threadId: stopThreadId,
        nodeId: rootNodeId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: baseline,
      });
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-stop-race:interrupt-request"),
        type: "turn-item.updated",
        threadId: stopThreadId,
        runId: stopRunId,
        nodeId: rootNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: ids.derive.runSignalTurnItem({ runId: stopRunId, signal: "interrupt-request" }),
          threadId: stopThreadId,
          runId: stopRunId,
          nodeId: rootNodeId,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: "Interrupt requested",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "run_interrupt_request",
          message: "Stopped by user",
        },
      });

      const committed = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
      const layerCapture = CheckpointCaptureService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              capturesSoFar: () => Effect.succeed(0),
              repositoryScopes: () => Effect.succeed([]),
              materializeBaselineCheckpoint: () => Effect.die("the baseline is already ready"),
              capture: () =>
                Effect.succeed({
                  ...baseline,
                  id: CheckpointId.make("checkpoint:stop-race-captured-1"),
                  runId: stopRunId,
                  parentCheckpointId: baseline.id,
                  ordinalWithinScope: 1,
                  appRunOrdinal: 1,
                  ref: CheckpointRef.make("checkpoint-ref:stop-race-captured-1"),
                }),
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
          service.execute({ threadId: stopThreadId, runId: stopRunId, scopeId: stopScopeId }),
        ),
        Effect.provide(layerCapture),
      );

      const events = yield* Ref.get(committed);
      const runUpdated = events.find((event) => event.type === "run.updated");
      assert.equal(
        runUpdated?.type === "run.updated" ? runUpdated.payload.status : undefined,
        "interrupted",
      );
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "turn-item.updated" && event.payload.type === "run_interrupt_result",
        ),
        "the accepted Stop request must be paired with a result",
      );
    }).pipe(Effect.provide(IdAllocator.layer)),
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
                    layerNoTrackedFolders,
                    Layer.mock(CheckpointStore.CheckpointStore)({
                      isGitRepository: () => Effect.succeed(true),
                      hasCheckpointRef: () => Effect.succeed(true),
                      captureCheckpoint: () => Effect.succeed(null),
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

  it.effect.each([false, true])(
    "records the checkpoint and keeps a run cancelled, cancelled during capture=%s",
    (cancelDuringCapture) =>
      Effect.gen(function* () {
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
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
        const applyStatus = (status: "waiting" | "cancelled", completedAt: DateTime.Utc | null) =>
          Effect.gen(function* () {
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
          }).pipe((effect) => threadCommands.withLock(cancelledThreadId, effect));
        yield* applyStatus("waiting", null);
        if (!cancelDuringCapture) yield* applyStatus("cancelled", cancelledAt);

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
                capturesSoFar: () => Effect.succeed(0),
                repositoryScopes: () => Effect.succeed([]),
                materializeBaselineCheckpoint: () =>
                  Effect.die("baseline materialization must be skipped when ordinal 0 is ready"),
                capture: () =>
                  (cancelDuringCapture ? applyStatus("cancelled", cancelledAt) : Effect.void).pipe(
                    Effect.as(captured),
                    Effect.orDie,
                  ),
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
        assert.deepEqual([...projected.preservedCheckpointOrdinals].toSorted(), [0, 1]);

        // A rewind leaves the run's checkpoint stale; the next capture must rebaseline it.
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-capture-cancelled:captured-stale"),
          type: "checkpoint.captured",
          threadId: cancelledThreadId,
          runId: cancelledRunId,
          nodeId: cancelledRootNodeId,
          providerInstanceId,
          occurredAt: cancelledAt,
          payload: { ...captured, status: "stale" },
        });
        const afterRewind = yield* projectionStore.getCheckpointCaptureContext(cancelledThreadId, {
          runId: cancelledRunId,
          scopeId: cancelledScopeId,
        });
        assert.deepEqual(afterRewind.preservedCheckpointOrdinals, [0]);

        // A failed capture still records which run ended there; the next capture must keep that link.
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-capture-cancelled:captured-error"),
          type: "checkpoint.captured",
          threadId: cancelledThreadId,
          runId: cancelledRunId,
          nodeId: cancelledRootNodeId,
          providerInstanceId,
          occurredAt: cancelledAt,
          payload: { ...captured, status: "error" },
        });
        const afterFailedCapture = yield* projectionStore.getCheckpointCaptureContext(
          cancelledThreadId,
          { runId: cancelledRunId, scopeId: cancelledScopeId },
        );
        assert.deepEqual([...afterFailedCapture.preservedCheckpointOrdinals].toSorted(), [0, 1]);
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
                  layerNoTrackedFolders,
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

  // A thread on real Git checkouts: `folders` is what the project tracks, read at each turn.
  const withTrackedRepositories = <A, E, R>(
    name: string,
    use: (context: {
      readonly root: string;
      readonly folders: Ref.Ref<ReadonlyArray<WorkspaceFolders.ThreadFolder>>;
      readonly git: (cwd: string, ...args: ReadonlyArray<string>) => Effect.Effect<string>;
      readonly initRepository: (cwd: string) => Effect.Effect<void>;
      readonly write: (file: string, contents: string) => Effect.Effect<void>;
      /** Runs one turn: baseline, the turn's edits, then the capture. Returns what it committed. */
      readonly turn: (
        ordinal: number,
        edits: Effect.Effect<void>,
      ) => Effect.Effect<
        ReadonlyArray<{
          readonly type: string;
          readonly label: string;
          readonly ordinal?: number;
          readonly run?: boolean;
          readonly status?: string;
          readonly files?: ReadonlyArray<string>;
        }>
      >;
      readonly capture: (ordinal: number) => Effect.Effect<void>;
      readonly commits: Ref.Ref<number>;
      readonly threadId: ThreadId;
      readonly ids: IdAllocator.IdAllocatorV2["Service"];
      readonly diffs: CheckpointDiffQuery.CheckpointDiffQuery["Service"];
      /** The git commands run since the last call, each as its subcommand and arguments. */
      readonly takeGitCommands: Effect.Effect<ReadonlyArray<ReadonlyArray<string>>>;
    }) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const repositoryThreadId = ThreadId.make(`thread:${name}`);
      const repositoryRootScopeId = CheckpointScopeId.make(`scope:${name}:root`);
      const repositoryProviderThreadId = ProviderThreadId.make(`provider-thread:${name}`);
      const folders = yield* Ref.make<ReadonlyArray<WorkspaceFolders.ThreadFolder>>([]);
      const commits = yield* Ref.make(0);
      const labels = new Map<string, string>([[repositoryRootScopeId, "root"]]);
      const committed = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
      const layerNode = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
      let gitCommands: Array<ReadonlyArray<string>> = [];
      const layerVcsProcess = Layer.effect(
        VcsProcess.VcsProcess,
        Effect.map(VcsProcess.VcsProcess, (inner) =>
          VcsProcess.VcsProcess.of({
            run: (input) =>
              Effect.suspend(() => {
                gitCommands.push(input.args);
                return inner.run(input);
              }),
          }),
        ),
      ).pipe(Layer.provide(VcsProcess.layer), Layer.provide(layerNode));
      const layerCheckpointStore = CheckpointStore.layer.pipe(
        Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(layerVcsProcess))),
        Layer.provide(layerNode),
      );
      const layerCheckpointService = CheckpointService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            layerNode,
            layerCheckpointStore,
            Layer.mock(WorkspaceFolders.WorkspaceFolders)({
              forThread: () =>
                Ref.get(folders).pipe(
                  Effect.map((current) => ({ folders: current, extraRoots: [] })),
                ),
              submodules: () => Effect.succeed([]),
            }),
          ),
        ),
      );
      const layer = Layer.mergeAll(
        IdAllocator.layer,
        layerNode,
        layerVcsProcess,
        layerCheckpointService,
        CheckpointCaptureService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              layerCheckpointService,
              Layer.mock(EventSink.EventSinkV2)({
                commitCommand: (input) =>
                  Effect.forEach(input.events, (event) => projectionStore.apply(event)).pipe(
                    Effect.andThen(Ref.set(committed, input.events)),
                    Effect.andThen(Ref.update(commits, (count) => count + 1)),
                    Effect.as({ committed: true } as never),
                    Effect.orDie,
                  ),
              }),
            ),
          ),
        ),
        CheckpointDiffQuery.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              layerNode,
              layerCheckpointStore,
              Layer.mock(ThreadManagement.ThreadManagementService)({
                getCheckpointContext: (id) =>
                  projectionStore.getCheckpointContext(id).pipe(Effect.orDie),
              }),
            ),
          ),
        ),
      ).pipe(
        Layer.provide(
          ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-capture-test-" }),
        ),
        Layer.provide(layerNode),
      );

      return yield* Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const vcsProcess = yield* VcsProcess.VcsProcess;
        const checkpoints = yield* CheckpointService.CheckpointServiceV2;
        const capture = yield* CheckpointCaptureService.CheckpointCaptureServiceV2;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: `${name}-` });
        const git = (cwd: string, ...args: ReadonlyArray<string>) =>
          vcsProcess.run({ operation: "test.git", command: "git", cwd, args }).pipe(
            Effect.map((result) => result.stdout.trim()),
            Effect.orDie,
          );
        const write = (file: string, contents: string) =>
          fileSystem
            .makeDirectory(path.dirname(file), { recursive: true })
            .pipe(Effect.andThen(fileSystem.writeFileString(file, contents)), Effect.orDie);
        const initRepository = (cwd: string) =>
          Effect.gen(function* () {
            yield* write(path.join(cwd, "README.md"), "# start\n");
            yield* git(cwd, "init");
            yield* git(cwd, "config", "user.email", "test@test.com");
            yield* git(cwd, "config", "user.name", "Test");
            yield* git(cwd, "add", ".");
            yield* git(cwd, "commit", "-m", "initial commit");
          });
        const rootScope = {
          id: repositoryRootScopeId,
          threadId: repositoryThreadId,
          runId: RunId.make(`run:${name}:1`),
          nodeId: NodeId.make(`node:${name}:1`),
          parentScopeId: null,
          providerThreadId: repositoryProviderThreadId,
          kind: "root_run" as const,
          ordinalWithinParent: 0,
          advancesAppRunCount: true,
          cwd: root,
          createdAt: now,
        };
        const event = { threadId: repositoryThreadId, providerInstanceId, occurredAt: now };
        yield* Effect.forEach(
          [
            {
              ...event,
              id: EventId.make(`event:${name}:thread`),
              type: "thread.created",
              payload: {
                createdBy: "user",
                creationSource: "web",
                id: repositoryThreadId,
                projectId,
                title: name,
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
                  rootThreadId: repositoryThreadId,
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
              id: EventId.make(`event:${name}:provider-thread`),
              type: "provider-thread.updated",
              driver,
              payload: {
                id: repositoryProviderThreadId,
                driver,
                providerInstanceId,
                providerSessionId: null,
                appThreadId: repositoryThreadId,
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
              id: EventId.make(`event:${name}:scope`),
              type: "checkpoint-scope.created",
              payload: rootScope,
            },
          ] satisfies ReadonlyArray<OrchestrationV2DomainEvent>,
          (seed) => projectionStore.apply(seed),
        );
        const seedRun = (ordinal: number) =>
          Effect.forEach(
            [
              {
                ...event,
                id: EventId.make(`event:${name}:run:${ordinal}`),
                type: "run.updated",
                runId: RunId.make(`run:${name}:${ordinal}`),
                payload: {
                  id: RunId.make(`run:${name}:${ordinal}`),
                  threadId: repositoryThreadId,
                  ordinal,
                  providerInstanceId,
                  modelSelection,
                  providerThreadId: repositoryProviderThreadId,
                  userMessageId: MessageId.make(`message:${name}:${ordinal}`),
                  rootNodeId: NodeId.make(`node:${name}:${ordinal}`),
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
                id: EventId.make(`event:${name}:node:${ordinal}`),
                type: "node.updated",
                runId: RunId.make(`run:${name}:${ordinal}`),
                payload: {
                  id: NodeId.make(`node:${name}:${ordinal}`),
                  threadId: repositoryThreadId,
                  runId: RunId.make(`run:${name}:${ordinal}`),
                  parentNodeId: null,
                  rootNodeId: NodeId.make(`node:${name}:${ordinal}`),
                  kind: "root_turn",
                  status: "waiting",
                  countsForRun: true,
                  providerThreadId: repositoryProviderThreadId,
                  providerTurnId: null,
                  nativeItemRef: null,
                  runtimeRequestId: null,
                  checkpointScopeId: repositoryRootScopeId,
                  startedAt: now,
                  completedAt: null,
                },
              },
            ] satisfies ReadonlyArray<OrchestrationV2DomainEvent>,
            (seed) => projectionStore.apply(seed),
          );
        const captureRun = (ordinal: number) =>
          capture
            .execute({
              threadId: repositoryThreadId,
              runId: RunId.make(`run:${name}:${ordinal}`),
              scopeId: repositoryRootScopeId,
            })
            .pipe(Effect.orDie);
        const turn = (ordinal: number, edits: Effect.Effect<void>) =>
          Effect.gen(function* () {
            yield* seedRun(ordinal);
            yield* checkpoints.captureBaseline({
              scope: rootScope,
              ordinalWithinScope: ordinal - 1,
              thread: { projectId, worktreePath: null },
            });
            yield* edits;
            yield* captureRun(ordinal);
            return (yield* Ref.get(committed)).flatMap((recorded) => {
              if (recorded.type === "checkpoint-scope.created") {
                labels.set(recorded.payload.id, recorded.payload.label ?? "unlabelled");
                return [{ type: "scope", label: recorded.payload.label ?? "unlabelled" }];
              }
              if (recorded.type !== "checkpoint.captured") return [];
              return [
                {
                  type: "checkpoint",
                  label: labels.get(recorded.payload.scopeId) ?? "unknown",
                  ordinal: recorded.payload.ordinalWithinScope,
                  run: recorded.payload.runId !== null,
                  status: recorded.payload.status,
                  files: recorded.payload.files.map((file) => file.path),
                },
              ];
            });
          }).pipe(Effect.orDie);
        return yield* use({
          root,
          folders,
          git,
          initRepository,
          write,
          turn,
          capture: captureRun,
          commits,
          threadId: repositoryThreadId,
          ids: yield* IdAllocator.IdAllocatorV2,
          diffs: yield* CheckpointDiffQuery.CheckpointDiffQuery,
          takeGitCommands: Effect.sync(() => {
            const taken = gitCommands;
            gitCommands = [];
            return taken;
          }),
        });
      }).pipe(Effect.provide(layer), Effect.scoped);
    });

  it.effect("captures a turn without re-reading the previous checkpoint", () =>
    withTrackedRepositories("capture-git-commands", (thread) =>
      Effect.gen(function* () {
        const { root } = thread;
        yield* thread.initRepository(root);
        yield* thread.turn(1, thread.write(`${root}/README.md`, "# one\n"));
        // Counted from after the turn's edits, so only the capture itself.
        const capture = (ordinal: number, edits: Effect.Effect<void>) =>
          Effect.gen(function* () {
            const recorded = yield* thread.turn(
              ordinal,
              edits.pipe(Effect.andThen(thread.takeGitCommands)),
            );
            return {
              files: recorded.flatMap((entry) => entry.files ?? []),
              commands: (yield* thread.takeGitCommands).map(gitSubcommand),
            };
          });
        // Turn 1 kept the scope's index, so no read-tree or ls-files rebuilds it. diff-tree
        // lists where it differs from HEAD, cat-file checks its blobs survived gc, and the
        // second diff-tree checks no .gitattributes changed under it.
        const snapshot = [
          "rev-parse",
          "log",
          "config",
          "diff-tree",
          "cat-file",
          "add",
          "write-tree",
          "diff-tree",
          "log",
          "commit-tree",
          "update-ref",
        ];

        assert.deepEqual(yield* capture(2, thread.write(`${root}/README.md`, "# two\n")), {
          files: ["README.md"],
          commands: [...snapshot, "diff"],
        });
        // Nothing changed, so there is nothing to diff.
        assert.deepEqual(yield* capture(3, Effect.void), { files: [], commands: snapshot });
        // A commit moves HEAD; its paths are read without resolving the range again.
        const committed = yield* capture(
          4,
          thread
            .write(`${root}/README.md`, "# four\n")
            .pipe(Effect.andThen(thread.git(root, "commit", "-am", "four")), Effect.asVoid),
        );
        assert.deepEqual(committed.files, ["README.md"]);
        // The summary's reads run side by side, so only which commands ran is fixed.
        assert.deepEqual(
          committed.commands.toSorted(),
          [
            ...snapshot,
            "diff",
            "version",
            "rev-list",
            "diff",
            "diff",
            "log",
            "log",
            "log",
          ].toSorted(),
        );
      }),
    ),
  );

  it.effect("checkpoints the repositories a folder that is not a repository holds", () =>
    withTrackedRepositories("capture-wrapper", (thread) =>
      Effect.gen(function* () {
        const { root } = thread;
        const repository = (name: string) => ({
          name,
          path: `${root}/${name}`,
          isGitRepository: true,
        });
        yield* Effect.forEach(["api", "web", "docs"], (name) =>
          thread.initRepository(`${root}/${name}`),
        );
        yield* thread.write(`${root}/notes/todo.md`, "plain folder\n");
        yield* Ref.set(thread.folders, [
          repository("api"),
          repository("web"),
          { name: "notes", path: `${root}/notes`, isGitRepository: false },
        ]);
        const ready = (label: string, ordinal: number, files?: ReadonlyArray<string>) => ({
          type: "checkpoint",
          label,
          ordinal,
          run: files !== undefined,
          status: "ready",
          files: files ?? [],
        });
        const missingRoot = (ordinal: number, run: boolean) => ({
          ...ready("root", ordinal, run ? [] : undefined),
          status: "missing",
        });

        // Only the repository the turn changed is recorded; `web` and the plain folder are not.
        assert.deepEqual(
          yield* thread.turn(1, thread.write(`${root}/api/README.md`, "# first\n")),
          [
            { type: "scope", label: "api" },
            ready("api", 0),
            ready("api", 1, ["README.md"]),
            missingRoot(0, false),
            missingRoot(1, true),
          ],
        );
        // An at-least-once retry of a settled run commits nothing more.
        yield* thread.capture(1);
        assert.strictEqual(yield* Ref.get(thread.commits), 1);

        // `docs` joins the project mid-thread and starts from this turn's baseline. `api` keeps
        // the scope it had, and the checkpoint its first turn recorded is this turn's baseline.
        yield* Ref.update(thread.folders, (current) => [...current, repository("docs")]);
        assert.deepEqual(
          yield* thread.turn(
            2,
            // The agent commits its work in `api` and leaves `docs` uncommitted.
            Effect.gen(function* () {
              yield* thread.write(`${root}/api/src/main.ts`, "export {};\n");
              yield* thread.git(`${root}/api`, "add", ".");
              yield* thread.git(`${root}/api`, "commit", "-m", "the turn's own commit");
              yield* thread.write(`${root}/docs/README.md`, "# docs\n");
            }),
          ),
          [
            ready("api", 2, ["src/main.ts"]),
            { type: "scope", label: "docs" },
            ready("docs", 1),
            ready("docs", 2, ["README.md"]),
            missingRoot(0, false),
            missingRoot(2, true),
          ],
        );
        const context = yield* ProjectionStore.ProjectionStoreV2.use((store) =>
          store.getCheckpointContext(thread.threadId),
        );
        assert.sameMembers(
          context.checkpointScopes.flatMap((scope) =>
            typeof scope.repositoryPath === "string" ? [scope.id] : [],
          ),
          yield* Effect.forEach(["api", "docs"], (name) =>
            thread.ids.allocate.checkpointScope({
              threadId: thread.threadId,
              name: `repository:${root}/${name}`,
            }),
          ),
        );

        const lastTurn = yield* thread.diffs.getTurnDiff({
          threadId: thread.threadId,
          fromTurnCount: 1,
          toTurnCount: 2,
        });
        assert.strictEqual(lastTurn.diff, "");
        assert.deepEqual(
          lastTurn.repositories?.map(({ diff: _diff, ...repository }) => repository),
          ["api", "docs"].map((name) => ({
            name,
            repositoryPath: `${root}/${name}`,
            relativePath: name,
          })),
        );
        assert.include(lastTurn.repositories?.[0]?.diff, "b/src/main.ts");
        assert.notInclude(lastTurn.repositories?.[0]?.diff, "README.md");
        // The whole thread: both of `api`'s turns, and `docs` from the turn it joined.
        const wholeThread = yield* thread.diffs.getFullThreadDiff({
          threadId: thread.threadId,
          toTurnCount: 2,
        });
        assert.deepEqual(
          wholeThread.repositories?.map((repository) => repository.name),
          ["api", "docs"],
        );
        assert.include(wholeThread.repositories?.[0]?.diff, "b/README.md");
        assert.include(wholeThread.repositories?.[0]?.diff, "b/src/main.ts");
      }),
    ),
  );

  it.effect("keeps a clone inside a Git project folder out of that folder's checkpoint", () =>
    withTrackedRepositories("capture-nested", (thread) =>
      Effect.gen(function* () {
        const { root } = thread;
        const clone = `${root}/vendor/lib`;
        yield* thread.initRepository(root);
        yield* thread.initRepository(clone);
        yield* Ref.set(thread.folders, [{ name: "lib", path: clone, isGitRepository: true }]);

        const recorded = yield* thread.turn(
          1,
          Effect.all([
            thread.write(`${root}/README.md`, "# project\n"),
            thread.write(`${clone}/README.md`, "# clone\n"),
          ]),
        );

        // The project folder lists its own file, not the clone as a gitlink or an untracked tree.
        assert.deepEqual(
          recorded.flatMap((entry) =>
            entry.run === true ? [{ label: entry.label, files: entry.files }] : [],
          ),
          [
            { label: "lib", files: ["README.md"] },
            { label: "root", files: ["README.md"] },
          ],
        );
        const turnDiff = yield* thread.diffs.getTurnDiff({
          threadId: thread.threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
        });
        assert.notInclude(turnDiff.diff, "vendor/lib");
        assert.deepEqual(
          turnDiff.repositories?.map((repository) => repository.relativePath),
          ["vendor/lib"],
        );
      }),
    ),
  );

  it.effect("keeps a submodule's pin in its repository's checkpoint", () =>
    withTrackedRepositories("capture-submodule", (thread) =>
      Effect.gen(function* () {
        const { root } = thread;
        const submodule = `${root}/vendor/lib`;
        yield* thread.initRepository(root);
        yield* thread.initRepository(submodule);
        yield* thread.write(
          `${root}/.gitmodules`,
          '[submodule "lib"]\n\tpath = vendor/lib\n\turl = ../lib\n',
        );
        yield* thread.git(root, "add", ".gitmodules", "vendor/lib");
        yield* thread.git(root, "commit", "-m", "Add lib");
        yield* Ref.set(thread.folders, [{ name: "lib", path: submodule, isGitRepository: true }]);

        const recorded = yield* thread.turn(
          1,
          Effect.gen(function* () {
            yield* thread.write(`${submodule}/README.md`, "# lib\n");
            yield* thread.git(submodule, "add", "README.md");
            yield* thread.git(submodule, "commit", "-m", "Describe lib");
          }),
        );

        assert.deepEqual(
          recorded.flatMap((entry) =>
            entry.run === true ? [{ label: entry.label, files: entry.files }] : [],
          ),
          [
            { label: "lib", files: ["README.md"] },
            { label: "root", files: ["vendor/lib"] },
          ],
        );
      }),
    ),
  );
});
