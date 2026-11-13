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
  it.effect("keeps later thread effects behind an earlier effect waiting to retry", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const workerId = "retry-order-worker";
      const commandId = CommandId.make("command:foundation-retry-order");
      const threadId = ThreadId.make("thread:foundation-retry-order");
      yield* outbox.enqueue([
        {
          id: "effect:foundation-retry-order:z-rollback",
          commandId,
          threadId,
          request: {
            type: "provider-thread.rollback",
            providerThreadId: ProviderThreadId.make("provider-thread:foundation-retry-order"),
            checkpointId: CheckpointId.make("checkpoint:foundation-retry-order"),
            scopeId: CheckpointScopeId.make("scope:foundation-retry-order"),
          },
        },
      ]);
      const rollback = yield* outbox.claimNext({ workerId });
      assert.isTrue(Option.isSome(rollback));
      if (Option.isNone(rollback)) return;
      yield* outbox.retry({
        effectId: rollback.value.id,
        workerId,
        error: "rollback failed once",
        delayMs: 60_000,
      });

      yield* outbox.enqueue([
        {
          id: "effect:foundation-retry-order:a-start",
          commandId: CommandId.make("command:foundation-retry-order:start"),
          threadId,
          request: { type: "provider-turn.start", runId: RunId.make("run:foundation-retry-order") },
        },
        {
          id: "effect:foundation-retry-order:b-title",
          commandId: CommandId.make("command:foundation-retry-order:title"),
          threadId,
          request: { type: "thread-title.generate", kind: { type: "regenerate" } },
        },
      ]);
      const title = yield* outbox.claimNext({ workerId });
      assert.equal(Option.getOrUndefined(title)?.id, "effect:foundation-retry-order:b-title");
      const blocked = yield* outbox.claimNext({ workerId });
      assert.isTrue(Option.isNone(blocked));
      const nextClaimable = yield* outbox.nextClaimableAt;
      assert.isTrue(Option.isSome(nextClaimable));
      if (Option.isSome(nextClaimable)) {
        assert.equal(
          DateTime.formatIso(nextClaimable.value),
          (yield* outbox.get(rollback.value.id)).pipe(Option.getOrThrow).availableAt,
        );
      }

      yield* outbox.cancelUnsettled({
        threadId,
        effectTypes: ["provider-thread.rollback"],
        reason: "Test cleanup.",
      });
      const unblocked = yield* outbox.claimNext({ workerId });
      assert.equal(Option.getOrUndefined(unblocked)?.id, "effect:foundation-retry-order:a-start");
      yield* outbox.succeed({ effectId: "effect:foundation-retry-order:a-start", workerId });
      yield* outbox.succeed({ effectId: "effect:foundation-retry-order:b-title", workerId });
    }).pipe(Effect.provide(Layer.fresh(layerEffectOutboxProvided))),
  );

  it.effect("runs distinct threads concurrently while serializing effects within a thread", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const commandId = CommandId.make("command:foundation-concurrent-effects");
      const threadA = ThreadId.make("thread:foundation-concurrent-effects:a");
      const threadB = ThreadId.make("thread:foundation-concurrent-effects:b");
      const effectA1 = "effect:foundation-concurrent-effects:a1";
      const effectA2 = "effect:foundation-concurrent-effects:a2";
      const effectB1 = "effect:foundation-concurrent-effects:b1";
      const startedA1 = yield* Deferred.make<void>();
      const startedA2 = yield* Deferred.make<void>();
      const startedB1 = yield* Deferred.make<void>();
      const releaseA1 = yield* Deferred.make<void>();
      const releaseA2 = yield* Deferred.make<void>();
      const releaseB1 = yield* Deferred.make<void>();
      const settled = yield* Deferred.make<void>();
      const completed = yield* Ref.make(0);
      const gates = new Map([
        [effectA1, { started: startedA1, release: releaseA1 }],
        [effectA2, { started: startedA2, release: releaseA2 }],
        [effectB1, { started: startedB1, release: releaseB1 }],
      ]);
      const layerExecutor = Layer.succeed(
        EffectWorker.OrchestrationEffectExecutorV2,
        EffectWorker.OrchestrationEffectExecutorV2.of({
          execute: (effect) => {
            const gate = gates.get(effect.id);
            if (gate === undefined) return Effect.die(`Missing gate for ${effect.id}`);
            return Deferred.succeed(gate.started, undefined).pipe(
              Effect.andThen(Deferred.await(gate.release)),
            );
          },
        }),
      );
      const layerWorker = EffectWorker.layerWithOptions({
        workerId: "concurrency-worker",
      }).pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(EffectOutbox.EffectOutboxV2, {
              ...outbox,
              succeed: (input) =>
                outbox
                  .succeed(input)
                  .pipe(
                    Effect.tap(() =>
                      Ref.updateAndGet(completed, (count) => count + 1).pipe(
                        Effect.flatMap((count) =>
                          count === 3 ? Deferred.succeed(settled, undefined) : Effect.void,
                        ),
                      ),
                    ),
                  ),
            }),
            layerExecutor,
          ),
        ),
      );

      yield* Effect.gen(function* () {
        yield* EffectWorker.runDaemonWithOptions({ concurrency: 2 }).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* outbox.enqueue([
          {
            id: effectA1,
            commandId,
            threadId: threadA,
            request: {
              type: "provider-turn.start",
              runId: RunId.make("run:foundation-concurrent-effects:a1"),
            },
          },
          {
            id: effectA2,
            commandId,
            threadId: threadA,
            request: {
              type: "provider-turn.start",
              runId: RunId.make("run:foundation-concurrent-effects:a2"),
            },
          },
          {
            id: effectB1,
            commandId,
            threadId: threadB,
            request: {
              type: "provider-turn.start",
              runId: RunId.make("run:foundation-concurrent-effects:b1"),
            },
          },
        ]);
        yield* outbox.notifyAvailable(3);

        yield* Effect.all([Deferred.await(startedA1), Deferred.await(startedB1)]);
        assert.isFalse(yield* Deferred.isDone(startedA2));

        yield* Deferred.succeed(releaseA1, undefined);
        yield* Deferred.succeed(releaseB1, undefined);
        yield* Deferred.await(startedA2);
        yield* Deferred.succeed(releaseA2, undefined);
        yield* Deferred.await(settled);
        assert.isTrue(
          (yield* outbox.listByCommandId(commandId)).every(
            (effect) => effect.status === "succeeded",
          ),
        );
      }).pipe(Effect.provide(layerWorker), Effect.scoped);
    }),
  );

  it.effect("does not reclaim a running effect after its process-local lease expires", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const sql = yield* SqlClient.SqlClient;
      const commandId = CommandId.make("command:foundation-no-live-reclaim");
      const threadId = ThreadId.make("thread:foundation-no-live-reclaim");
      const firstEffectId = "effect:foundation-no-live-reclaim:first";
      const secondEffectId = "effect:foundation-no-live-reclaim:second";
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const executions = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* outbox.enqueue([
        {
          id: firstEffectId,
          commandId,
          threadId,
          request: { type: "terminal.cleanup" },
        },
        {
          id: secondEffectId,
          commandId,
          threadId,
          request: { type: "terminal.cleanup" },
        },
      ]);

      const layerExecutor = Layer.succeed(
        EffectWorker.OrchestrationEffectExecutorV2,
        EffectWorker.OrchestrationEffectExecutorV2.of({
          execute: (effect) =>
            Ref.update(executions, (current) => [...current, effect.id]).pipe(
              Effect.andThen(
                effect.id === firstEffectId
                  ? Deferred.succeed(firstStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseFirst)),
                    )
                  : Effect.void,
              ),
            ),
        }),
      );
      const layerWorker = EffectWorker.layerWithOptions({
        workerId: "no-live-reclaim-worker",
      }).pipe(
        Layer.provide(
          Layer.merge(Layer.succeed(EffectOutbox.EffectOutboxV2, outbox), layerExecutor),
        ),
      );

      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const firstFiber = yield* worker.runOnce.pipe(Effect.forkChild);
        yield* Deferred.await(firstStarted);
        yield* sql`
          UPDATE orchestration_v2_effect_outbox
          SET lease_expires_at = '1970-01-01T00:00:00.000Z'
          WHERE effect_id = ${firstEffectId}
        `;

        assert.isFalse(yield* worker.runOnce);
        assert.deepEqual(yield* Ref.get(executions), [firstEffectId]);

        yield* Deferred.succeed(releaseFirst, undefined);
        assert.isTrue(yield* Fiber.join(firstFiber));
        assert.isTrue(yield* worker.runOnce);
        assert.deepEqual(yield* Ref.get(executions), [firstEffectId, secondEffectId]);
      }).pipe(Effect.provide(layerWorker));
    }),
  );

  it.effect.each([{ replayed: false }, { replayed: true }] as const)(
    "starts later thread work behind a delegated-task stop that never returns (replayed: $replayed)",
    ({ replayed }) =>
      Effect.gen(function* () {
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const key = `foundation-hung-delegated-stop:${replayed}`;
        const threadId = ThreadId.make(`thread:${key}`);
        const stopEffectId = `effect:${key}:stop`;
        const stopStarted = yield* Deferred.make<void>();
        const turnStarted = yield* Deferred.make<void>();
        yield* outbox.enqueue([
          {
            id: stopEffectId,
            commandId: CommandId.make(`command:${key}:stop`),
            threadId,
            request: { type: "delegated-tasks.stop" },
          },
        ]);
        if (replayed) {
          assert.isTrue(Option.isSome(yield* outbox.claimNext({ workerId: "crashed-worker" })));
          assert.equal((yield* outbox.reconcileAfterProcessLoss).requeued, 1);
        }

        const layerExecutor = Layer.succeed(
          EffectWorker.OrchestrationEffectExecutorV2,
          EffectWorker.OrchestrationEffectExecutorV2.of({
            execute: (effect) =>
              effect.request.type === "delegated-tasks.stop"
                ? Deferred.succeed(stopStarted, undefined).pipe(Effect.andThen(Effect.never))
                : Deferred.succeed(turnStarted, undefined),
          }),
        );
        const layerWorker = EffectWorker.layerWithOptions({
          workerId: "hung-delegated-stop-worker",
        }).pipe(
          Layer.provide(
            Layer.merge(Layer.succeed(EffectOutbox.EffectOutboxV2, outbox), layerExecutor),
          ),
        );

        yield* Effect.gen(function* () {
          yield* EffectWorker.runDaemonWithOptions({ concurrency: 2 }).pipe(Effect.forkScoped);
          yield* Deferred.await(stopStarted);
          yield* outbox.enqueue([
            {
              id: `effect:${key}:turn`,
              commandId: CommandId.make(`command:${key}:turn`),
              threadId,
              request: { type: "provider-turn.start", runId: RunId.make(`run:${key}`) },
            },
          ]);
          yield* outbox.notifyAvailable();

          const turn = yield* Deferred.await(turnStarted).pipe(
            Effect.timeoutOption("1 hour"),
            Effect.forkChild,
          );
          yield* TestClock.adjust("1 hour");
          assert.isTrue(
            Option.isSome(yield* Fiber.join(turn)),
            "provider-turn.start never ran behind the hung delegated-tasks.stop",
          );
          const stop = yield* outbox.get(stopEffectId);
          assert.isTrue(Option.isSome(stop));
          if (Option.isSome(stop)) {
            assert.equal(stop.value.status, "failed");
            assert.include(stop.value.lastError ?? "", "Timed out");
          }
        }).pipe(
          Effect.provide(layerWorker),
          Effect.scoped,
          Effect.ensuring(
            outbox
              .cancelUnsettled({
                threadId,
                effectTypes: ["delegated-tasks.stop", "provider-turn.start"],
                reason: "fixture complete",
              })
              .pipe(Effect.orDie),
          ),
        );
      }),
  );

  it.effect(
    "persists shutdown continuation intent through the real event sink without domain events",
    () =>
      Effect.gen(function* () {
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:shutdown-prepare");
        const runId = RunId.make("run:shutdown-prepare");
        const providerThreadId = ProviderThreadId.make("provider-thread:shutdown-prepare");
        const sessionId = ProviderSessionId.make("session:shutdown-prepare");
        const attemptId = RunAttemptId.make("attempt:shutdown-prepare");
        const projection = {
          thread: makeThread(threadId, now),
          runs: [
            {
              id: runId,
              ordinal: 1,
              status: "running",
              providerInstanceId,
              providerThreadId,
              activeAttemptId: attemptId,
            },
          ],
          providerThreads: [
            {
              id: providerThreadId,
              appThreadId: threadId,
              ownerNodeId: null,
              driver: "codex",
              providerInstanceId,
              providerSessionId: sessionId,
              status: "active",
              nativeThreadRef: {
                driver: "codex",
                nativeId: "saved-native-thread",
                strength: "strong",
              },
            },
          ],
          providerSessions: [
            { id: sessionId, driver: "codex", providerInstanceId, status: "running" },
          ],
          providerTurns: [{ providerThreadId, runAttemptId: attemptId, status: "running" }],
          runtimeRequests: [],
          turnItems: [],
        } as unknown as OrchestrationV2ThreadProjection;
        const recovery = yield* ProviderRuntimeRecovery.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getRecoveryThreadIds: () => Effect.succeed([threadId]),
                getRuntimeRecoveryProjection: () => Effect.succeed(projection),
              }),
              Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({}),
            ),
          ),
        );
        yield* recovery.prepareForShutdown;
        yield* recovery.prepareForShutdown;
        const effects = yield* outbox.listByCommandId(
          CommandId.make(`command:restart-prepare:${runId}`),
        );
        assert.lengthOf(effects, 1);
        assert.equal(effects[0]?.status, "pending");
        assert.deepEqual(effects[0]?.request, {
          type: "provider-runtime.continue",
          sourceRunId: runId,
        });
        yield* outbox.cancelUnsettled({
          threadId,
          effectTypes: ["provider-runtime.continue"],
          reason: "fixture complete",
        });
      }),
  );

  it.effect("leaves restart continuation pending until normal worker claims are enabled", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make("thread:activation-restart");
      const commandId = CommandId.make("command:activation-restart");
      yield* outbox.enqueue([
        {
          id: "effect:activation-a-restart",
          commandId,
          threadId,
          request: { type: "provider-runtime.continue", sourceRunId: RunId.make("run:activation") },
        },
        {
          id: "effect:activation-b-cleanup",
          commandId,
          threadId,
          request: { type: "terminal.cleanup" },
        },
      ]);
      const cleanup = yield* outbox.claimNext({
        workerId: "recovery",
        excludeRestartContinuations: true,
      });
      assert.isTrue(Option.isSome(cleanup));
      if (Option.isSome(cleanup)) {
        assert.equal(cleanup.value.request.type, "terminal.cleanup");
        yield* outbox.succeed({ effectId: cleanup.value.id, workerId: "recovery" });
      }
      assert.isTrue(
        Option.isNone(
          yield* outbox.claimNext({
            workerId: "recovery",
            excludeRestartContinuations: true,
          }),
        ),
      );
      const pending = yield* outbox.get("effect:activation-a-restart");
      assert.isTrue(Option.isSome(pending));
      if (Option.isSome(pending)) assert.equal(pending.value.status, "pending");
      const resumed = yield* outbox.claimNext({ workerId: "activated" });
      assert.isTrue(Option.isSome(resumed));
      if (Option.isSome(resumed)) {
        assert.equal(resumed.value.request.type, "provider-runtime.continue");
        yield* outbox.succeed({ effectId: resumed.value.id, workerId: "activated" });
      }
    }),
  );

  it.effect.each([
    { type: "terminal.cleanup" },
    { type: "provider-runtime.continue", sourceRunId: RunId.make("run:restart-replay") },
  ] as const)(
    "retires live provider effects and requeues $type after process loss",
    (replayRequest) =>
      Effect.gen(function* () {
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const commandId = CommandId.make(
          `command:foundation-reclaim-running:${replayRequest.type}`,
        );
        yield* outbox.enqueue([
          {
            id: `effect:a-foundation-cancel-provider-turn:${replayRequest.type}`,
            commandId,
            threadId: ThreadId.make(`thread:foundation-reclaim-running:${replayRequest.type}`),
            request: {
              type: "provider-turn.start",
              runId: RunId.make(`run:foundation-reclaim-running:${replayRequest.type}`),
            },
          },
          {
            id: `effect:b-foundation-requeue-cleanup:${replayRequest.type}`,
            commandId,
            threadId: ThreadId.make(`thread:foundation-reclaim-cleanup:${replayRequest.type}`),
            request: replayRequest,
          },
        ]);
        assert.isTrue(Option.isSome(yield* outbox.claimNext({ workerId: "crashed-worker" })));
        assert.isTrue(Option.isSome(yield* outbox.claimNext({ workerId: "crashed-worker" })));
        assert.deepEqual(yield* outbox.reconcileAfterProcessLoss, {
          cancelled: 1,
          requeued: 1,
        });
        const cancelled = yield* outbox.get(
          `effect:a-foundation-cancel-provider-turn:${replayRequest.type}`,
        );
        assert.isTrue(Option.isSome(cancelled));
        if (Option.isSome(cancelled)) assert.equal(cancelled.value.status, "cancelled");

        const reclaimed = yield* outbox.claimNext({
          workerId: "recovery-worker",
        });
        assert.isTrue(Option.isSome(reclaimed));
        if (Option.isSome(reclaimed)) {
          assert.equal(reclaimed.value.request.type, replayRequest.type);
          assert.equal(reclaimed.value.attemptCount, 2);
          yield* outbox.succeed({ effectId: reclaimed.value.id, workerId: "recovery-worker" });
        }
      }),
  );

  it.effect("atomically cancels stale runs and their process-bound effects", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:foundation-process-loss");
      const runId = RunId.make("run:foundation-process-loss");
      const commandId = CommandId.make("command:foundation-process-loss");
      const thread = makeThread(threadId, now);
      yield* eventSink.commitCommand({
        commandId,
        threadId,
        commandType: "foundation.process-loss",
        acceptedAt: now,
        events: [
          threadCreatedEvent({ id: "event:foundation-process-loss:thread", thread, now }),
          {
            id: EventId.make("event:foundation-process-loss:run"),
            type: "run.created",
            threadId,
            runId,
            providerInstanceId,
            occurredAt: now,
            payload: {
              id: runId,
              threadId,
              ordinal: 1,
              providerInstanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: MessageId.make("message:foundation-process-loss"),
              rootNodeId: null,
              activeAttemptId: null,
              status: "starting",
              queuePosition: null,
              requestedAt: now,
              startedAt: null,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
        ],
        effects: [
          {
            id: "effect:foundation-process-loss",
            commandId,
            threadId,
            request: { type: "provider-turn.start", runId },
          },
        ],
      });
      assert.isTrue(Option.isSome(yield* outbox.claimNext({ workerId: "crashed-worker" })));

      const recovery = yield* ProviderRuntimeRecovery.make.pipe(
        Effect.provide(ServerSettings.layerTest()),
        Effect.provideService(
          EffectWorker.OrchestrationEffectWorkerV2,
          EffectWorker.OrchestrationEffectWorkerV2.of({
            awaitWork: Effect.void,
            runRecoveryOnce: Effect.succeed(false),
            runOnce: Effect.succeed(false),
            nextClaimableAt: Effect.succeedNone,
            drain: () => Effect.succeed(0),
          }),
        ),
      );
      const first = yield* recovery.recover;
      assert.equal(first.terminalizedRuns, 1);
      assert.equal(first.retiredEffects, 1);
      const projection = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(projection.runs[0]?.status, "cancelled");
      const effect = yield* outbox.get("effect:foundation-process-loss");
      assert.isTrue(Option.isSome(effect));
      if (Option.isSome(effect)) assert.equal(effect.value.status, "cancelled");

      const second = yield* recovery.recover;
      assert.equal(second.terminalizedRuns, 0);
      assert.equal(second.retiredEffects, 0);
    }),
  );
});
