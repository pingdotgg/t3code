// @effect-diagnostics nodeBuiltinImport:off -- fixtures and tests use Node builtins

import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Scheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { vi } from "vite-plus/test";
import * as ServerConfig from "../config.ts";
import * as DatabaseStorage from "../persistence/DatabaseStorage.ts";
import * as ServerSettings from "../serverSettings.ts";
import { LIVE_STREAM_MAX_ITEMS, LiveStreamBufferError } from "./LiveStreamBudget.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionReplay from "./testkit/ProjectionReplay.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

import {
  encodeJson,
  isLiveStreamBufferError,
  layerCommandReceiptStoreProvided,
  layerDatabase,
  layerEffectOutboxProvided,
  layerEventSinkProvided,
  layerEventStoreProvided,
  layerIsolatedOutbox,
  layerProjectionMaintenanceProvided,
  layerProjectionReplayProvided,
  layerProjectionStoreProvided,
  layerStoresProvided,
  layerTest,
  makeThread,
  modelSelection,
  providerDriver,
  providerInstanceId,
  seedCompaction,
  threadCreatedEvent,
} from "./FoundationPersistence-fixtures.testkit.ts";

it.layer(layerTest)("orchestration V2 foundation persistence", (it) => {
  it.effect("guards post-terminal provider-thread writes by attempt and run ordinal", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:foundation-provider-thread-owner");
      const runId = RunId.make("run:foundation-provider-thread-owner");
      const attemptId = RunAttemptId.make("attempt:foundation-provider-thread-owner");
      const replacementAttemptId = RunAttemptId.make(
        "attempt:foundation-provider-thread-owner:replacement",
      );
      const rootNodeId = NodeId.make("node:foundation-provider-thread-owner");
      const providerThreadId = ProviderThreadId.make(
        "provider-thread:foundation-provider-thread-owner",
      );
      const thread = makeThread(threadId, now);
      const run: OrchestrationV2Run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId,
        userMessageId: MessageId.make("message:foundation-provider-thread-owner"),
        rootNodeId,
        activeAttemptId: attemptId,
        status: "completed",
        queuePosition: null,
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      };
      const baseProviderThread = {
        id: providerThreadId,
        driver: providerDriver,
        providerInstanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle" as const,
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [] as const,
        forkedFrom: null,
        pendingBackgroundTasks: [
          { taskId: "bg-owner", description: "sleep 20", kind: "command" as const },
        ],
        createdAt: now,
        updatedAt: now,
      };

      yield* eventSink.write({
        events: [
          threadCreatedEvent({
            id: "event:foundation-provider-thread-owner:thread",
            thread,
            now,
          }),
          {
            id: EventId.make("event:foundation-provider-thread-owner:run"),
            type: "run.created",
            threadId,
            runId,
            nodeId: rootNodeId,
            providerInstanceId,
            occurredAt: now,
            payload: run,
          },
          {
            id: EventId.make("event:foundation-provider-thread-owner:provider-thread"),
            type: "provider-thread.updated",
            threadId,
            driver: providerDriver,
            providerInstanceId,
            occurredAt: now,
            payload: baseProviderThread,
          },
        ],
      });

      const ownedClear = yield* eventSink.writeIfProviderThreadOwner({
        providerThreadId,
        runId,
        activeAttemptId: attemptId,
        expectedLastRunOrdinal: 1,
        events: [
          {
            id: EventId.make("event:foundation-provider-thread-owner:clear"),
            type: "provider-thread.updated",
            threadId,
            driver: providerDriver,
            providerInstanceId,
            occurredAt: now,
            payload: {
              ...baseProviderThread,
              pendingBackgroundTasks: [],
              updatedAt: now,
            },
          },
        ],
      });
      assert.isTrue(ownedClear.committed);
      assert.equal(ownedClear.storedEvents.length, 1);

      const afterReplacement = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:foundation-provider-thread-owner:replacement-attempt"),
            type: "run.updated",
            threadId,
            runId,
            nodeId: rootNodeId,
            providerInstanceId,
            occurredAt: afterReplacement,
            payload: {
              ...run,
              activeAttemptId: replacementAttemptId,
              status: "running",
            },
          },
        ],
      });

      const supersededAttemptWrite = yield* eventSink.writeIfProviderThreadOwner({
        providerThreadId,
        runId,
        activeAttemptId: attemptId,
        expectedLastRunOrdinal: 1,
        events: [
          {
            id: EventId.make("event:foundation-provider-thread-owner:superseded-attempt"),
            type: "provider-thread.updated",
            threadId,
            driver: providerDriver,
            providerInstanceId,
            occurredAt: afterReplacement,
            payload: {
              ...baseProviderThread,
              status: "active",
              pendingBackgroundTasks: [
                {
                  taskId: "bg-superseded",
                  description: "should not land",
                  kind: "command" as const,
                },
              ],
              updatedAt: afterReplacement,
            },
          },
        ],
      });
      assert.isFalse(supersededAttemptWrite.committed);
      assert.deepEqual(supersededAttemptWrite.storedEvents, []);

      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:foundation-provider-thread-owner:replacement-completed"),
            type: "run.updated",
            threadId,
            runId,
            nodeId: rootNodeId,
            providerInstanceId,
            occurredAt: afterReplacement,
            payload: {
              ...run,
              activeAttemptId: replacementAttemptId,
            },
          },
          {
            id: EventId.make("event:foundation-provider-thread-owner:newer-run"),
            type: "provider-thread.updated",
            threadId,
            driver: providerDriver,
            providerInstanceId,
            occurredAt: afterReplacement,
            payload: {
              ...baseProviderThread,
              lastRunOrdinal: 2,
              status: "active",
              pendingBackgroundTasks: [],
              updatedAt: afterReplacement,
            },
          },
        ],
      });

      const staleOrdinalWrite = yield* eventSink.writeIfProviderThreadOwner({
        providerThreadId,
        runId,
        activeAttemptId: replacementAttemptId,
        expectedLastRunOrdinal: 1,
        events: [
          {
            id: EventId.make("event:foundation-provider-thread-owner:stale-ordinal"),
            type: "provider-thread.updated",
            threadId,
            driver: providerDriver,
            providerInstanceId,
            occurredAt: afterReplacement,
            payload: baseProviderThread,
          },
        ],
      });
      assert.isFalse(staleOrdinalWrite.committed);
      assert.deepEqual(staleOrdinalWrite.storedEvents, []);

      const projection = yield* projectionStore.getThreadProjection(threadId);
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === providerThreadId,
      );
      assert.isDefined(providerThread);
      assert.equal(providerThread?.lastRunOrdinal, 2);
      assert.equal(providerThread?.status, "active");
      assert.deepEqual(providerThread?.pendingBackgroundTasks ?? [], []);
    }),
  );

  it.effect("interrupts a running process-bound effect when it is cancelled", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const commandId = CommandId.make("command:foundation-cancel-running-effect");
      const threadId = ThreadId.make("thread:foundation-cancel-running-effect");
      const effectId = "effect:foundation-cancel-running-effect";
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      yield* outbox.enqueue([
        {
          id: effectId,
          commandId,
          threadId,
          request: {
            type: "provider-turn.start",
            runId: RunId.make("run:foundation-cancel-running-effect"),
          },
        },
      ]);

      const layerExecutor = Layer.succeed(
        EffectWorker.OrchestrationEffectExecutorV2,
        EffectWorker.OrchestrationEffectExecutorV2.of({
          execute: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Deferred.succeed(interrupted, undefined).pipe(Effect.ignore),
              ),
            ),
        }),
      );
      const layerWorker = EffectWorker.layerWithOptions({
        workerId: "cancellation-worker",
      }).pipe(
        Layer.provide(
          Layer.merge(Layer.succeed(EffectOutbox.EffectOutboxV2, outbox), layerExecutor),
        ),
      );

      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const workerFiber = yield* worker.runOnce.pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const cancelledEffectIds = yield* outbox.cancelUnsettled({
          threadId,
          effectTypes: ["provider-turn.start"],
          reason: "The owning run was interrupted.",
        });
        assert.deepEqual(cancelledEffectIds, [effectId]);
        yield* outbox.signalCancellations(cancelledEffectIds);
        assert.isTrue(yield* Fiber.join(workerFiber));
        yield* Deferred.await(interrupted);
      }).pipe(Effect.provide(layerWorker));

      const cancelled = yield* outbox.get(effectId);
      assert.isTrue(Option.isSome(cancelled));
      if (Option.isSome(cancelled)) assert.equal(cancelled.value.status, "cancelled");
    }),
  );

  it.effect("does not start an effect that was cancelled during claim registration", () =>
    Effect.gen(function* () {
      const effectId = "effect:foundation-cancelled-during-claim";
      const threadId = ThreadId.make("thread:foundation-cancelled-during-claim");
      const commandId = CommandId.make("command:foundation-cancelled-during-claim");
      const now = DateTime.formatIso(yield* DateTime.now);
      const claimedEffect = {
        id: effectId,
        commandId,
        threadId,
        request: { type: "terminal.cleanup" as const },
        status: "running" as const,
        attemptCount: 1,
        availableAt: now,
        leaseOwner: "claim-cancellation-worker",
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        lastError: null,
      };
      const executionCount = yield* Ref.make(0);
      const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
        claimNext: () => Effect.succeedSome(claimedEffect),
        get: () =>
          Effect.succeedSome({
            ...claimedEffect,
            status: "cancelled" as const,
            leaseOwner: null,
            completedAt: now,
          }),
        clearCancellation: () => Effect.void,
        awaitCancellation: () => Effect.never,
      });
      const layerExecutor = Layer.succeed(
        EffectWorker.OrchestrationEffectExecutorV2,
        EffectWorker.OrchestrationEffectExecutorV2.of({
          execute: () => Ref.update(executionCount, (count) => count + 1),
        }),
      );
      const layerWorker = EffectWorker.layerWithOptions({
        workerId: "claim-cancellation-worker",
      }).pipe(Layer.provide(Layer.merge(layerOutbox, layerExecutor)));

      assert.isTrue(
        yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
          Effect.flatMap((worker) => worker.runOnce),
          Effect.provide(layerWorker),
        ),
      );
      assert.equal(yield* Ref.get(executionCount), 0);
    }),
  );

  it.effect("allows only one worker to claim an available effect", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const commandId = CommandId.make("command:foundation-exclusive-claim");
      yield* outbox.enqueue([
        {
          id: "effect:foundation-exclusive-claim",
          commandId,
          threadId: ThreadId.make("thread:foundation-exclusive-claim"),
          request: {
            type: "provider-turn.start",
            runId: RunId.make("run:foundation-exclusive-claim"),
          },
        },
      ]);

      const claims = yield* Effect.all(
        [outbox.claimNext({ workerId: "worker-a" }), outbox.claimNext({ workerId: "worker-b" })],
        { concurrency: "unbounded" },
      );
      assert.equal(claims.filter(Option.isSome).length, 1);
      assert.equal(claims.filter(Option.isNone).length, 1);
      const claimedByA = claims[0];
      const claimedByB = claims[1];
      if (Option.isSome(claimedByA)) {
        yield* outbox.succeed({ effectId: claimedByA.value.id, workerId: "worker-a" });
      }
      if (Option.isSome(claimedByB)) {
        yield* outbox.succeed({ effectId: claimedByB.value.id, workerId: "worker-b" });
      }
    }),
  );

  it.effect("wakes a settle waiter when its effect finishes", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const effectId = "effect:foundation-await-settled";
      yield* outbox.enqueue([
        {
          id: effectId,
          commandId: CommandId.make("command:foundation-await-settled"),
          threadId: ThreadId.make("thread:foundation-await-settled"),
          request: {
            type: "provider-runtime.continue",
            sourceRunId: RunId.make("run:foundation-await-settled"),
          },
        },
      ]);
      const waiter = yield* outbox.awaitSettled(effectId).pipe(Effect.forkChild);
      const claimed = yield* outbox.claimNext({
        workerId: "settle-worker",
      });
      assert.isTrue(Option.isSome(claimed));
      yield* Effect.yieldNow;
      assert.isUndefined(waiter.pollUnsafe());

      yield* outbox.succeed({ effectId, workerId: "settle-worker" });
      yield* Fiber.join(waiter);
      yield* outbox.awaitSettled(effectId);
    }),
  );

  it.effect("runs title generation beside critical work while serializing each lane", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const commandId = CommandId.make("command:foundation-title-effect-lane");
      const threadId = ThreadId.make("thread:foundation-title-effect-lane");
      const titleEffectId = "effect:foundation-title-effect-lane:a-title";
      const providerEffectId = "effect:foundation-title-effect-lane:b-provider";
      const nextTitleEffectId = "effect:foundation-title-effect-lane:c-title";
      const nextCriticalEffectId = "effect:foundation-title-effect-lane:d-critical";
      yield* outbox.enqueue([
        {
          id: titleEffectId,
          commandId,
          threadId,
          request: {
            type: "thread-title.generate",
            kind: {
              type: "initial",
              messageId: MessageId.make("message:foundation-title-effect-lane"),
            },
          },
        },
        {
          id: providerEffectId,
          commandId,
          threadId,
          request: {
            type: "provider-turn.start",
            runId: RunId.make("run:foundation-title-effect-lane"),
          },
        },
        {
          id: nextTitleEffectId,
          commandId,
          threadId,
          request: { type: "thread-title.generate", kind: { type: "regenerate" } },
        },
        {
          id: nextCriticalEffectId,
          commandId,
          threadId,
          request: { type: "terminal.cleanup" },
        },
      ]);

      const title = yield* outbox.claimNext({
        workerId: "title-lane-worker",
      });
      assert.isTrue(Option.isSome(title));
      if (Option.isNone(title)) return;
      assert.equal(title.value.id, titleEffectId);

      const provider = yield* outbox.claimNext({
        workerId: "critical-lane-worker",
      });
      assert.isTrue(Option.isSome(provider));
      if (Option.isNone(provider)) return;
      assert.equal(provider.value.id, providerEffectId);

      assert.isTrue(
        Option.isNone(
          yield* outbox.claimNext({
            workerId: "blocked-lanes-worker",
          }),
        ),
      );

      yield* outbox.succeed({
        effectId: provider.value.id,
        workerId: "critical-lane-worker",
      });
      const nextCritical = yield* outbox.claimNext({
        workerId: "critical-lane-worker",
      });
      assert.isTrue(Option.isSome(nextCritical));
      if (Option.isNone(nextCritical)) return;
      assert.equal(nextCritical.value.id, nextCriticalEffectId);
      yield* outbox.succeed({
        effectId: nextCritical.value.id,
        workerId: "critical-lane-worker",
      });

      yield* outbox.succeed({
        effectId: title.value.id,
        workerId: "title-lane-worker",
      });
      const nextTitle = yield* outbox.claimNext({
        workerId: "title-lane-worker",
      });
      assert.isTrue(Option.isSome(nextTitle));
      if (Option.isSome(nextTitle)) {
        assert.equal(nextTitle.value.id, nextTitleEffectId);
        yield* outbox.succeed({
          effectId: nextTitle.value.id,
          workerId: "title-lane-worker",
        });
      }
    }),
  );

  it.effect("ignores deadlines blocked by a running effect on the same thread", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const now = yield* DateTime.now;
      const future = DateTime.add(now, { seconds: 10 });
      const commandId = CommandId.make("command:foundation-next-claimable");
      const blockedThreadId = ThreadId.make("thread:foundation-next-claimable:blocked");
      yield* outbox.enqueue([
        {
          id: "effect:foundation-next-claimable:a1",
          commandId,
          threadId: blockedThreadId,
          request: { type: "terminal.cleanup" },
        },
        {
          id: "effect:foundation-next-claimable:a2",
          commandId,
          threadId: blockedThreadId,
          request: { type: "terminal.cleanup" },
        },
        {
          id: "effect:foundation-next-claimable:b1",
          commandId,
          threadId: ThreadId.make("thread:foundation-next-claimable:future"),
          request: { type: "terminal.cleanup" },
          availableAt: future,
        },
      ]);

      const claimed = yield* outbox.claimNext({
        workerId: "next-claimable-worker",
      });
      assert.isTrue(Option.isSome(claimed));
      if (Option.isNone(claimed)) return;
      assert.equal(claimed.value.id, "effect:foundation-next-claimable:a1");

      const whileBlocked = yield* outbox.nextClaimableAt;
      assert.isTrue(Option.isSome(whileBlocked));
      if (Option.isSome(whileBlocked)) {
        assert.equal(DateTime.toEpochMillis(whileBlocked.value), DateTime.toEpochMillis(future));
      }

      yield* outbox.succeed({
        effectId: claimed.value.id,
        workerId: "next-claimable-worker",
      });
      const afterCompletion = yield* outbox.nextClaimableAt;
      assert.isTrue(Option.isSome(afterCompletion));
      if (Option.isSome(afterCompletion)) {
        assert.isAtMost(DateTime.toEpochMillis(afterCompletion.value), DateTime.toEpochMillis(now));
      }

      const unblocked = yield* outbox.claimNext({
        workerId: "next-claimable-worker",
      });
      assert.isTrue(Option.isSome(unblocked));
      if (Option.isSome(unblocked)) {
        assert.equal(unblocked.value.id, "effect:foundation-next-claimable:a2");
        yield* outbox.succeed({
          effectId: unblocked.value.id,
          workerId: "next-claimable-worker",
        });
      }
      yield* outbox.cancelUnsettled({
        threadId: ThreadId.make("thread:foundation-next-claimable:future"),
        effectTypes: ["terminal.cleanup"],
        reason: "Test cleanup.",
      });
    }),
  );

  it.effect("prunes settled effects past retention in batches and keeps the rest", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const insert = (
        prefix: string,
        count: number,
        status: EffectOutbox.OrchestrationEffectStatusV2,
        completedAgo: Duration.Duration | null,
      ) => {
        const completedAt =
          completedAgo === null
            ? null
            : DateTime.formatIso(DateTime.subtractDuration(now, completedAgo));
        const createdAt = DateTime.formatIso(now);
        return sql`
          WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
          INSERT INTO orchestration_v2_effect_outbox (
            effect_id, command_id, thread_id, effect_type, payload_json, status,
            available_at, created_at, updated_at, completed_at
          )
          SELECT ${prefix} || i, 'command:prune', 'thread:prune', 'terminal.cleanup',
            '{"type":"terminal.cleanup"}', ${status}, ${createdAt}, ${createdAt}, ${createdAt},
            ${completedAt}
          FROM n
        `;
      };
      const old = Duration.sum(EffectOutbox.SETTLED_EFFECT_RETENTION, Duration.minutes(1));
      const recent = Duration.subtract(EffectOutbox.SETTLED_EFFECT_RETENTION, Duration.minutes(1));
      yield* insert("succeeded-old:", 1_201, "succeeded", old);
      yield* insert("cancelled-old:", 2, "cancelled", old);
      yield* insert("succeeded-recent:", 1, "succeeded", recent);
      yield* insert("failed-old:", 1, "failed", old);
      yield* insert("pending:", 1, "pending", null);
      yield* insert("running:", 1, "running", null);

      assert.equal(yield* outbox.pruneSettled, 1_203);

      const remaining = yield* sql<{ readonly effect_id: string }>`
        SELECT effect_id FROM orchestration_v2_effect_outbox ORDER BY effect_id
      `;
      assert.deepEqual(
        remaining.map((row) => row.effect_id),
        ["failed-old:1", "pending:1", "running:1", "succeeded-recent:1"],
      );
      assert.equal(yield* outbox.pruneSettled, 0);
    }).pipe(Effect.provide(layerIsolatedOutbox)),
  );

  it.effect("wakes claimers when cancellation unblocks same-thread work", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const commandId = CommandId.make("command:foundation-cancellation-wakeup");
      const threadId = ThreadId.make("thread:foundation-cancellation-wakeup");
      yield* outbox.enqueue([
        {
          id: "effect:foundation-cancellation-wakeup:a-running",
          commandId,
          threadId,
          request: {
            type: "provider-turn.start",
            runId: RunId.make("run:foundation-cancellation-wakeup"),
          },
        },
        {
          id: "effect:foundation-cancellation-wakeup:b-pending",
          commandId,
          threadId,
          request: { type: "terminal.cleanup" },
        },
      ]);

      const running = yield* outbox.claimNext({
        workerId: "cancellation-wakeup-worker",
      });
      assert.isTrue(Option.isSome(running));
      if (Option.isNone(running)) return;
      assert.equal(running.value.request.type, "provider-turn.start");

      const cancelledEffectIds = yield* outbox.cancelUnsettled({
        threadId,
        effectTypes: ["provider-turn.start"],
        reason: "Test cancellation wakeup.",
      });
      yield* outbox.signalCancellations(cancelledEffectIds);

      const wake = yield* outbox.awaitAvailable.pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.isDefined(wake.pollUnsafe());

      const unblocked = yield* outbox.claimNext({
        workerId: "cancellation-wakeup-worker",
      });
      assert.isTrue(Option.isSome(unblocked));
      if (Option.isSome(unblocked)) {
        assert.equal(unblocked.value.request.type, "terminal.cleanup");
        yield* outbox.succeed({
          effectId: unblocked.value.id,
          workerId: "cancellation-wakeup-worker",
        });
      }
    }).pipe(Effect.provide(Layer.fresh(layerEffectOutboxProvided))),
  );
});
