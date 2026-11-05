import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  NodeId,
  ProjectId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  VcsProcessExitError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { AssistedLearningRunner } from "../project/knowledge/assistedLearningSchedule.ts";
import * as ModelEvaluations from "../modelEvaluations/ModelEvaluations.ts";
import { modelEvaluationEffects } from "../modelEvaluations/modelEvaluationSchedule.ts";
import {
  ConversationSummaryPassError,
  ConversationSummaryRuntime,
} from "../project/conversationSummaries/conversationSummarySchedule.ts";
import {
  DeliveryScrubRunner,
  deliveryScrubEffect,
} from "../project/knowledge/deliveryScrubSchedule.ts";

it.effect("coalesces delivery scrub roots and resumes bounded pages after process loss", () =>
  Effect.gen(function* () {
    const pages = yield* Ref.make<ReadonlyArray<string | undefined>>([]);
    const projectId = ProjectId.make("project:scrub-pages");
    const root = deliveryScrubEffect({ projectId, removalId: "removal:1" });
    const duplicate = deliveryScrubEffect({ projectId, removalId: "removal:2" });
    const runner = Layer.succeed(DeliveryScrubRunner, {
      scrubPage: ({ afterId }) =>
        Ref.update(pages, (values) => [...values, afterId]).pipe(
          Effect.as(afterId === undefined ? "delivery:page-1" : null),
        ),
    });
    const dependencies = Layer.merge(
      EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
      Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, { execute: () => Effect.void }),
    );
    const layer = EffectWorker.layer.pipe(Layer.provideMerge(dependencies), Layer.provide(runner));
    yield* Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* outbox.enqueue([root, duplicate]);
      assert.isTrue(Option.isNone(yield* outbox.get(duplicate.id)));
      assert.isTrue(yield* worker.runMaintenanceOnce);
      assert.deepEqual(yield* Ref.get(pages), [undefined]);
      const continuation = deliveryScrubEffect({
        projectId,
        removalId: "removal:1",
        afterId: "delivery:page-1",
      });
      yield* outbox.enqueue([continuation]);
      const claimed = yield* outbox.claimNext({
        workerId: "lost-worker",
        lane: "maintenance",
      });
      assert.isTrue(Option.isSome(claimed));
      assert.deepEqual(yield* outbox.reconcileAfterProcessLoss, { requeued: 1, cancelled: 0 });
      assert.equal(yield* worker.drain(), 1);
      assert.deepEqual(yield* Ref.get(pages), [undefined, "delivery:page-1"]);
      yield* outbox.enqueue([root, continuation]);
      assert.equal(yield* worker.drain(), 0);
    }).pipe(Effect.provide(layer));
  }),
);

const threadId = ThreadId.make("thread:effect-worker-restart");

it.effect(
  "continues bounded summary passes without a new turn and resumes after process loss",
  () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const root = {
        id: "effect:conversation-summary.generate:run:summary-pages",
        commandId: CommandId.make("command:effect:conversation-summary.generate:run:summary-pages"),
        threadId,
        request: {
          type: "conversation-summary.generate",
          runId: RunId.make("run:summary-pages"),
        },
      } as const;
      const runner = Layer.succeed(ConversationSummaryRuntime, {
        summarizeThread: () =>
          Ref.updateAndGet(calls, (count) => count + 1).pipe(
            Effect.map((count) => ({ hasMore: count < 3 })),
          ),
        forHandoff: () => Effect.succeed([]),
      });
      const dependencies = Layer.merge(
        EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
        Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, { execute: () => Effect.void }),
      );
      const layer = EffectWorker.layer.pipe(
        Layer.provideMerge(dependencies),
        Layer.provide(runner),
      );
      yield* Effect.gen(function* () {
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* outbox.enqueue([root, root]);
        assert.isTrue(yield* worker.runMaintenanceOnce);
        const continuation = yield* outbox.get(`${root.id}:pass:1`);
        assert.isTrue(Option.isSome(continuation));
        const claimed = yield* outbox.claimNext({ workerId: "lost-worker", lane: "maintenance" });
        assert.isTrue(Option.isSome(claimed));
        assert.deepEqual(yield* outbox.reconcileAfterProcessLoss, { requeued: 1, cancelled: 0 });
        assert.equal(yield* worker.drain(), 2);
        assert.equal(yield* Ref.get(calls), 3);
        assert.isTrue(Option.isNone(yield* outbox.get(`${root.id}:pass:3`)));
        yield* outbox.enqueue([root]);
        assert.equal(yield* worker.drain(), 0);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("retries a failed summary pass before scheduling its continuation", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const root = {
      id: "effect:conversation-summary.generate:run:summary-retry",
      commandId: CommandId.make("command:effect:conversation-summary.generate:run:summary-retry"),
      threadId,
      request: {
        type: "conversation-summary.generate",
        runId: RunId.make("run:summary-retry"),
      },
    } as const;
    const runner = Layer.succeed(ConversationSummaryRuntime, {
      summarizeThread: ({ runId }) =>
        Ref.updateAndGet(calls, (count) => count + 1).pipe(
          Effect.flatMap((count) =>
            count === 1
              ? Effect.fail(new ConversationSummaryPassError({ runId, cause: "model unavailable" }))
              : Effect.succeed({ hasMore: count === 2 }),
          ),
        ),
      forHandoff: () => Effect.succeed([]),
    });
    const dependencies = Layer.merge(
      EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
      Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, { execute: () => Effect.void }),
    );
    const layer = EffectWorker.layer.pipe(Layer.provideMerge(dependencies), Layer.provide(runner));
    yield* Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* outbox.enqueue([root]);
      assert.isTrue(yield* worker.runMaintenanceOnce);
      const retrying = yield* outbox.get(root.id);
      assert.isTrue(Option.isSome(retrying));
      if (Option.isSome(retrying)) {
        assert.equal(retrying.value.status, "pending");
        assert.equal(retrying.value.attemptCount, 1);
      }
      assert.isTrue(Option.isNone(yield* outbox.get(`${root.id}:pass:1`)));
      assert.equal(yield* worker.drain(), 0);
      yield* TestClock.adjust(100);
      assert.equal(yield* worker.drain(), 2);
      assert.equal(yield* Ref.get(calls), 3);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect.each(["turn", "maintenance"] as const)(
  "wakes the %s lane when the other lane is waiting first",
  (lane) =>
    Effect.gen(function* () {
      const releaseTarget = yield* Deferred.make<void>();
      const executed = yield* Deferred.make<void>();
      const dependencies = Layer.merge(
        EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
        Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, {
          execute: () => Deferred.succeed(executed, undefined).pipe(Effect.asVoid),
        }),
      );
      const layer = EffectWorker.layer.pipe(Layer.provideMerge(dependencies));
      yield* Effect.gen(function* () {
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const delayedProbe = Deferred.await(releaseTarget).pipe(
          Effect.andThen(lane === "turn" ? worker.runTurnOnce : worker.runMaintenanceOnce),
        );
        yield* EffectWorker.runDaemonWithOptions({ concurrency: 1 }).pipe(
          Effect.provideService(EffectWorker.OrchestrationEffectWorkerV2, {
            ...worker,
            ...(lane === "turn"
              ? { runTurnOnce: delayedProbe }
              : { runMaintenanceOnce: delayedProbe }),
          }),
          Effect.forkScoped,
        );
        // Park the other lane first without advancing the liveness clock.
        yield* TestClock.adjust(0);
        yield* Deferred.succeed(releaseTarget, undefined);
        yield* TestClock.adjust(0);
        const effectId = `effect:wake:${lane}`;
        yield* outbox.enqueue([
          {
            id: effectId,
            commandId: CommandId.make(`command:wake:${lane}`),
            threadId,
            request:
              lane === "turn"
                ? { type: "provider-turn.start", runId: RunId.make("run:wake:turn") }
                : {
                    type: "project-knowledge.extract",
                    runId: RunId.make("run:wake:maintenance"),
                    runOutcome: "completed",
                  },
          },
        ]);
        yield* outbox.notifyAvailable();
        yield* TestClock.adjust(0);
        assert.isTrue(
          yield* Deferred.isDone(executed),
          `A single commit notification must wake the ${lane} lane without polling`,
        );
        yield* outbox.awaitSettled(effectId);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("admits turns while delivery scrub is held and retains the next removal", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const turns = yield* Ref.make(0);
    const projectId = ProjectId.make("project:scrub-held");
    const root = deliveryScrubEffect({ projectId, removalId: "held:1" });
    const next = deliveryScrubEffect({ projectId, removalId: "held:2" });
    const runner = Layer.succeed(DeliveryScrubRunner, {
      scrubPage: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(null),
        ),
    });
    const dependencies = Layer.merge(
      EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
      Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, {
        execute: () => Ref.update(turns, (count) => count + 1),
      }),
    );
    const layer = EffectWorker.layer.pipe(Layer.provideMerge(dependencies), Layer.provide(runner));
    yield* Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* outbox.enqueue([root]);
      yield* worker.runMaintenanceOnce.pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* outbox.enqueue([
        next,
        {
          id: "effect:scrub-turn",
          commandId: CommandId.make("command:scrub-turn"),
          threadId: root.threadId,
          request: { type: "provider-turn.start", runId: RunId.make("run:scrub-turn") },
        },
      ]);
      assert.isTrue(Option.isSome(yield* outbox.get(next.id)));
      assert.isTrue(yield* worker.runTurnOnce);
      assert.equal(yield* Ref.get(turns), 1);
      assert.isFalse(yield* Deferred.isDone(release));
      yield* Deferred.succeed(release, undefined);
      yield* outbox.awaitSettled(root.id);
      assert.equal(yield* worker.drain(), 1);
    }).pipe(Effect.provide(layer));
  }),
);
const oldSessionId = ProviderSessionId.make("provider-session:effect-worker-restart:old");
const providerThreadId = ProviderThreadId.make("provider-thread:effect-worker-restart");
const providerTurnId = ProviderTurnId.make("provider-turn:effect-worker-restart");
const attemptId = RunAttemptId.make("run-attempt:effect-worker-restart");
const runId = RunId.make("run:effect-worker-restart");

it.effect(
  "replays model evaluations once on the maintenance lane without holding a later turn",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const job = modelEvaluationEffects({
        threadId,
        runId,
        runOutcome: "completed",
        settings: { ...DEFAULT_SERVER_SETTINGS, enableModelEvaluations: true },
      })[0]!;
      const executor = layerExecutorFor({
        events,
        modelEvaluations: {
          evaluateRun: (request) =>
            Ref.update(events, (value) => [
              ...value,
              `judge:${request.runId}:${request.runOutcome}`,
            ]).pipe(
              Effect.andThen(Deferred.succeed(entered, undefined)),
              Effect.andThen(Deferred.await(release)),
            ),
        },
      });
      const layer = EffectWorker.layer.pipe(
        Layer.provideMerge(
          Layer.merge(
            EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
            executor,
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* outbox.enqueue([job]);
        assert.isTrue(
          Option.isSome(yield* outbox.claimNext({ workerId: "lost-judge", lane: "maintenance" })),
        );
        assert.deepEqual(yield* outbox.reconcileAfterProcessLoss, { requeued: 1, cancelled: 0 });
        yield* worker.runMaintenanceOnce.pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* outbox.enqueue([
          {
            id: "effect:after-judge",
            commandId: CommandId.make("command:after-judge"),
            threadId,
            request: { type: "provider-turn.start", runId },
          },
        ]);
        assert.isTrue(yield* worker.runTurnOnce);
        assert.isFalse(yield* Deferred.isDone(release));
        yield* Deferred.succeed(release, undefined);
        yield* outbox.awaitSettled(job.id);
        yield* outbox.enqueue([job]);
        assert.equal(yield* worker.drain(), 0);
        assert.deepEqual(yield* Ref.get(events), [`judge:${runId}:completed`, "start"]);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect.each(["project-knowledge.extract", "conversation-summary.generate"] as const)(
  "starts a follow-up turn while %s is held",
  (maintenance) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const outboxLayer = EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));
      const hold = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const runners = Layer.merge(
        Layer.succeed(AssistedLearningRunner, { extractRun: () => hold }),
        Layer.succeed(ConversationSummaryRuntime, {
          summarizeThread: () => hold.pipe(Effect.as({ hasMore: false })),
          forHandoff: () => Effect.succeed([]),
        }),
      );
      const dependencies = Layer.merge(outboxLayer, layerExecutorFor({ events }));
      const layer = EffectWorker.layer.pipe(
        Layer.provideMerge(dependencies),
        Layer.provide(runners),
      );
      yield* Effect.gen(function* () {
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* outbox.enqueue([
          {
            id: "effect:held-maintenance",
            commandId: CommandId.make("command:held-maintenance"),
            threadId,
            request:
              maintenance === "project-knowledge.extract"
                ? { type: maintenance, runId, runOutcome: "completed" }
                : { type: maintenance, runId },
          },
        ]);
        yield* worker.runMaintenanceOnce.pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* outbox.enqueue([
          {
            id: "effect:follow-up",
            commandId: CommandId.make("command:follow-up"),
            threadId,
            request: { type: "provider-turn.start", runId: RunId.make("run:follow-up") },
          },
        ]);
        assert.isTrue(yield* worker.runTurnOnce);
        assert.deepEqual(yield* Ref.get(events), ["start"]);
        assert.isFalse(yield* Deferred.isDone(release));
        yield* Deferred.succeed(release, undefined);
        yield* outbox.awaitSettled("effect:held-maintenance");
      }).pipe(Effect.provide(layer));
    }),
);

it.effect.each(["provider-turn.start", "thread-title.generate"] as const)(
  "admits %s while heavy maintenance is held",
  (target) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();
      const executor = Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, {
        execute: (effect) =>
          effect.request.type === "project-knowledge.extract"
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Deferred.succeed(completed, undefined).pipe(Effect.asVoid),
      });
      const dependencies = Layer.merge(
        EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
        executor,
      );
      const layer = EffectWorker.layer.pipe(Layer.provideMerge(dependencies));
      yield* Effect.gen(function* () {
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        // Independent threads expose global pool saturation rather than per-thread ordering.
        yield* outbox.enqueue(
          Array.from({ length: target === "provider-turn.start" ? 5 : 1 }, (_, index) => ({
            id: `effect:heavy:${index}`,
            commandId: CommandId.make(`command:heavy:${index}`),
            threadId: ThreadId.make(`thread:heavy:${index}`),
            request: {
              type: "project-knowledge.extract" as const,
              runId: RunId.make(`run:heavy:${index}`),
              runOutcome: "completed" as const,
            },
          })),
        );
        yield* EffectWorker.runDaemonWithOptions({ concurrency: 4 }).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* outbox.enqueue([
          {
            id: "effect:visible",
            commandId: CommandId.make("command:visible"),
            threadId,
            request:
              target === "provider-turn.start"
                ? { type: target, runId }
                : { type: target, kind: { type: "regenerate" } },
          },
        ]);
        // Settle runnable daemon fibers through its safety wakeup on the virtual clock.
        yield* TestClock.adjust("30 seconds");
        assert.isTrue(
          yield* Deferred.isDone(completed),
          `${target} must complete while maintenance is held`,
        );
        yield* outbox.awaitSettled("effect:visible");
        assert.isFalse(yield* Deferred.isDone(release));
        yield* Deferred.succeed(release, undefined);
        yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      }).pipe(Effect.provide(layer));
    }),
);

function restartEffect(
  now: DateTime.Utc,
  sessionTransition: NonNullable<
    Extract<
      EffectOutbox.OrchestrationEffectV2["request"],
      { readonly type: "provider-turn.restart" }
    >["sessionTransition"]
  >,
): EffectOutbox.OrchestrationEffectV2 {
  const timestamp = DateTime.formatIso(now);
  return {
    id: `effect:restart:${sessionTransition.type}`,
    commandId: CommandId.make(`command:restart:${sessionTransition.type}`),
    threadId,
    request: {
      type: "provider-turn.restart",
      providerSessionId: oldSessionId,
      providerThreadId,
      providerTurnId,
      interruptedAttemptId: attemptId,
      runId,
      sessionTransition,
    },
    status: "running",
    attemptCount: 1,
    availableAt: timestamp,
    leaseOwner: "test-worker",
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    lastError: null,
  };
}

function layerExecutorFor(input: {
  readonly events: Ref.Ref<ReadonlyArray<string>>;
  readonly failFirstStart?: Ref.Ref<boolean>;
  readonly threads?: Partial<ThreadManagementService.ThreadManagementService["Service"]>;
  readonly modelEvaluations?: Partial<ModelEvaluations.ModelEvaluations["Service"]>;
  readonly continueAfterRestart?: boolean;
  readonly interrupt?: ProviderTurnControlService.ProviderTurnControlServiceV2Shape["interrupt"];
  readonly rollback?: CheckpointRollbackService.CheckpointRollbackServiceV2Shape["execute"];
  readonly respond?: RuntimeRequestService.RuntimeRequestServiceV2["Service"]["respond"];
}) {
  const record = (event: string) => Ref.update(input.events, (events) => [...events, event]);
  const layerDependencies = Layer.mergeAll(
    Layer.succeed(
      ProviderTurnControlService.ProviderTurnControlServiceV2,
      ProviderTurnControlService.ProviderTurnControlServiceV2.of({
        interrupt: input.interrupt ?? (() => Effect.void),
        steer: () => Effect.void,
        interruptAndAwaitTerminal: (request) =>
          record(
            request.replacementProviderSessionId === undefined
              ? "interrupt"
              : `interrupt:${request.replacementProviderSessionId}`,
          ),
      }),
    ),
    Layer.succeed(
      ProviderSessionManager.ProviderSessionManagerV2,
      ProviderSessionManager.ProviderSessionManagerV2.of({
        shutdown: Effect.void,
        open: () => Effect.die("unused open"),
        get: () => Effect.succeedNone,
        isLive: () => Effect.succeed(false),
        close: () => Effect.void,
        closeInstance: () => Effect.void,
        release: () => record("release"),
        detach: () => record("detach"),
        otherWorkingThreads: () => Effect.succeed([]),
        releaseUnlessBusy: () => Effect.succeed(true),
      }),
    ),
    Layer.succeed(
      ProviderTurnStartService.ProviderTurnStartServiceV2,
      ProviderTurnStartService.ProviderTurnStartServiceV2.of({
        start: () =>
          Effect.gen(function* () {
            yield* record("start");
            if (
              input.failFirstStart !== undefined &&
              (yield* Ref.getAndSet(input.failFirstStart, false))
            ) {
              return yield* new ProviderTurnStartService.ProviderTurnStartError({
                runId,
                cause: "simulated first start failure",
              });
            }
          }),
      }),
    ),
    Layer.succeed(
      RunFinalizationService.RunFinalizationService,
      RunFinalizationService.RunFinalizationService.of({ finalize: () => Effect.void }),
    ),
    Layer.succeed(
      CheckpointRollbackService.CheckpointRollbackServiceV2,
      CheckpointRollbackService.CheckpointRollbackServiceV2.of({
        execute: input.rollback ?? (() => Effect.void),
      }),
    ),
    Layer.succeed(
      RuntimeRequestService.RuntimeRequestServiceV2,
      RuntimeRequestService.RuntimeRequestServiceV2.of({
        respond: input.respond ?? (() => Effect.void),
      }),
    ),
    Layer.succeed(
      ThreadTitleRegenerationService.ThreadTitleRegenerationService,
      ThreadTitleRegenerationService.ThreadTitleRegenerationService.of({
        execute: () => Effect.void,
      }),
    ),
  );
  return EffectWorker.layerExecutor.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerDependencies,
        Layer.mock(ModelEvaluations.ModelEvaluations)({
          enqueueRun: () => Effect.void,
          ...input.modelEvaluations,
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)(input.threads ?? {}),
        ServerSettings.layerTest(
          input.continueAfterRestart === true ? { continueThreadsAfterServerUpdate: true } : {},
        ),
      ),
    ),
  );
}

it.effect.each([
  {
    name: "settles a stopped run when its adapter has already lost the native turn",
    unresponsive: false,
    dispatched: ["thread.background-work.settle"],
  },
  {
    name: "leaves the run running and flags the Stop when the provider never confirms it",
    unresponsive: true,
    dispatched: ["thread.interrupt.unresponsive"],
  },
])("$name", ({ unresponsive, dispatched }) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = layerExecutorFor({
      events,
      interrupt: () =>
        new ProviderTurnControlService.ProviderTurnControlError({
          threadId,
          operation: "interrupt",
          providerTurnId,
          ...(unresponsive ? { unresponsive } : {}),
          cause: unresponsive ? "Timed out." : "Provider turn is not active.",
        }),
      threads: {
        dispatch: (command) =>
          Ref.update(events, (current) => [...current, command.type]).pipe(
            Effect.as({ sequence: 1, storedEvents: [] }),
          ),
      },
    });
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      yield* executor.execute({
        ...restartEffect(now, { type: "detach" }),
        request: {
          type: "provider-turn.interrupt",
          providerSessionId: oldSessionId,
          providerThreadId,
          providerTurnId,
        },
      });
    }).pipe(Effect.provide(layer));
    assert.deepEqual(yield* Ref.get(events), dispatched);
  }),
);

const lockedIndexMessage =
  "Git's index is locked. Wait for other Git operations to finish, then try again.";
const rollbackCheckpointId = CheckpointId.make("checkpoint:effect-worker-rollback");
const rollbackScopeId = CheckpointScopeId.make("checkpoint-scope:effect-worker-rollback");
const restoreFailure = (detail: string) =>
  new CheckpointRollbackService.CheckpointRollbackExecutionError({
    reason: "unexpected-failure",
    threadId,
    providerThreadId,
    checkpointId: rollbackCheckpointId,
    cause: new CheckpointService.CheckpointRestoreError({
      scopeId: rollbackScopeId,
      checkpointId: rollbackCheckpointId,
      cause: new VcsProcessExitError({
        operation: "GitVcsDriverCore.restoreCheckpoint",
        command: "git",
        cwd: "/private/repo",
        exitCode: 128,
        detail,
        failureKind: "command-failed",
      }),
    }),
  });

it.effect.each([
  {
    name: "a held Git index lock",
    failure: restoreFailure(lockedIndexMessage),
    message: lockedIndexMessage,
  },
  {
    name: "raw Git output",
    failure: restoreFailure("error: could not clean /private/repo/secret.txt"),
    message: CheckpointRollbackService.ROLLBACK_FAILED_MESSAGE,
  },
])("reports a rollback blocked by $name only after the last attempt", ({ failure, message }) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const failures = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = layerExecutorFor({
      events: yield* Ref.make<ReadonlyArray<string>>([]),
      rollback: () => Effect.fail(failure),
      threads: {
        dispatch: (command) =>
          Ref.update(failures, (current) =>
            command.type === "checkpoint.rollback.fail" ? [...current, command.message] : current,
          ).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
      },
    });
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      const rollback: EffectOutbox.OrchestrationEffectV2 = {
        ...restartEffect(now, { type: "detach" }),
        request: {
          type: "provider-thread.rollback",
          providerThreadId,
          checkpointId: rollbackCheckpointId,
          scopeId: rollbackScopeId,
          restoreFiles: true,
        },
      };
      yield* Effect.flip(executor.execute(rollback, { willRetry: true }));
      assert.deepEqual(yield* Ref.get(failures), []);
      yield* Effect.flip(executor.execute(rollback, { willRetry: false }));
    }).pipe(Effect.provide(layer));
    assert.deepEqual(yield* Ref.get(failures), [message]);
  }),
);

it.effect("does not report an answer whose last delivery attempt is interrupted", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const reported = yield* Ref.make(0);
    const layer = layerExecutorFor({
      events: yield* Ref.make<ReadonlyArray<string>>([]),
      respond: () => Effect.interrupt,
      threads: {
        dispatch: (command) =>
          Ref.update(reported, (count) =>
            command.type === "runtime-request.delivery.fail" ? count + 1 : count,
          ).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
      },
    });
    const exit = yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      return yield* Effect.exit(
        executor.execute(
          {
            ...restartEffect(now, { type: "detach" }),
            request: {
              type: "runtime-request.respond",
              providerSessionId: oldSessionId,
              requestId: RuntimeRequestId.make("runtime-request:effect-worker-interrupted"),
              answers: { next: "Ship it" },
            },
          },
          { willRetry: false },
        ),
      );
    }).pipe(Effect.provide(layer));
    assert.isTrue(Exit.hasInterrupts(exit));
    assert.equal(yield* Ref.get(reported), 0);
  }),
);

it.effect("requeues a claim when a pre-execution worker check fails", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-pre-execution-failure";
    const workerId = "worker-pre-execution-failure";
    const claimedEffect: EffectOutbox.OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-pre-execution-failure"),
      threadId: ThreadId.make("thread:worker-pre-execution-failure"),
      request: { type: "terminal.cleanup" },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const retries = yield* Ref.make<
      ReadonlyArray<{
        readonly effectId: string;
        readonly workerId: string;
        readonly error: string;
        readonly delayMs: number;
      }>
    >([]);
    const executionCount = yield* Ref.make(0);
    const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeedSome(claimedEffect),
      get: () =>
        Effect.fail(
          new EffectOutbox.EffectOutboxError({
            operation: "get",
            effectId,
            cause: "simulated cancellation-state read failure",
          }),
        ),
      retry: (input) =>
        Ref.update(retries, (existing) => [...existing, input]).pipe(Effect.as(true)),
    });
    const layerExecutor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: () => Ref.update(executionCount, (count) => count + 1),
      }),
    );
    const layerWorker = EffectWorker.layerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.merge(layerOutbox, layerExecutor)),
    );

    const exit = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce),
      Effect.provide(layerWorker),
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      assert.include(Cause.pretty(exit.cause), "simulated cancellation-state read failure");
    }
    assert.equal(yield* Ref.get(executionCount), 0);
    const retry = (yield* Ref.get(retries))[0];
    assert.isDefined(retry);
    assert.equal(retry.effectId, effectId);
    assert.equal(retry.workerId, workerId);
    assert.equal(retry.delayMs, 0);
    assert.include(retry.error, "simulated cancellation-state read failure");
  }),
);

it.effect("arms cancellation before the durable pre-execution check", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-cancellation-registration-race";
    const workerId = "worker-cancellation-registration-race";
    const claimedEffect: EffectOutbox.OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-cancellation-registration-race"),
      threadId: ThreadId.make("thread:worker-cancellation-registration-race"),
      request: { type: "terminal.cleanup" },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const signal = yield* Deferred.make<void>();
    let cancellationArmed = false;
    const executionCount = yield* Ref.make(0);
    const settlementCount = yield* Ref.make(0);
    const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeedSome(claimedEffect),
      awaitCancellation: () => {
        cancellationArmed = true;
        return Deferred.await(signal);
      },
      get: () =>
        Effect.gen(function* () {
          if (cancellationArmed) {
            yield* Deferred.succeed(signal, undefined);
          }
          return Option.some(claimedEffect);
        }),
      clearCancellation: () => Effect.void,
      succeed: () => Ref.update(settlementCount, (count) => count + 1).pipe(Effect.as(true)),
    });
    const layerExecutor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: () =>
          Effect.yieldNow.pipe(Effect.andThen(Ref.update(executionCount, (count) => count + 1))),
      }),
    );
    const layerWorker = EffectWorker.layerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.merge(layerOutbox, layerExecutor)),
    );

    const exit = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce),
      Effect.provide(layerWorker),
      Effect.exit,
    );

    if (Exit.isFailure(exit)) {
      assert.fail(Cause.pretty(exit.cause));
    }
    assert.equal(yield* Ref.get(executionCount), 0);
    assert.equal(yield* Ref.get(settlementCount), 0);
  }),
);

it.effect("terminalizes a process-bound claim when success settlement fails", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-process-bound-settlement-failure";
    const workerId = "worker-process-bound-settlement-failure";
    const claimedEffect: EffectOutbox.OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-process-bound-settlement-failure"),
      threadId: ThreadId.make("thread:worker-process-bound-settlement-failure"),
      request: {
        type: "provider-turn.start",
        runId: RunId.make("run:worker-process-bound-settlement-failure"),
      },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const retries = yield* Ref.make(0);
    const terminalErrors = yield* Ref.make<ReadonlyArray<string>>([]);
    const executionCount = yield* Ref.make(0);
    const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeedSome(claimedEffect),
      get: () => Effect.succeedSome(claimedEffect),
      awaitCancellation: () => Effect.never,
      clearCancellation: () => Effect.void,
      succeed: () =>
        Effect.fail(
          new EffectOutbox.EffectOutboxError({
            operation: "succeed",
            effectId,
            cause: "simulated success settlement failure",
          }),
        ),
      retry: () => Ref.update(retries, (count) => count + 1).pipe(Effect.as(true)),
      fail: ({ error }) =>
        Ref.update(terminalErrors, (existing) => [...existing, error]).pipe(Effect.as(true)),
    });
    const layerExecutor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: () => Ref.update(executionCount, (count) => count + 1),
      }),
    );
    const layerWorker = EffectWorker.layerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.merge(layerOutbox, layerExecutor)),
    );

    const exit = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce),
      Effect.provide(layerWorker),
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    assert.equal(yield* Ref.get(executionCount), 1);
    assert.equal(yield* Ref.get(retries), 0);
    const terminalError = (yield* Ref.get(terminalErrors))[0];
    assert.isDefined(terminalError);
    assert.include(terminalError, "after execution started");
    assert.include(terminalError, "simulated success settlement failure");
  }),
);

it.effect("settles a delegated child once its restart continuation fails for good", () =>
  Effect.gen(function* () {
    const timestamp = DateTime.formatIso(yield* DateTime.now);
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const recovered = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
    const layer = layerExecutorFor({
      events,
      continueAfterRestart: true,
      threads: {
        getThreadRecords: () => Effect.fail(new Error("provider instance removed") as never),
        recoverDelegatedTask: (childThreadId) =>
          Ref.update(recovered, (ids) => [...ids, childThreadId]),
      },
    });
    const effect: EffectOutbox.OrchestrationEffectV2 = {
      id: `effect:restart-continuation:${runId}`,
      commandId: CommandId.make("command:restart-continuation-failure"),
      threadId,
      request: { type: "provider-runtime.continue", sourceRunId: runId },
      status: "running",
      attemptCount: 1,
      availableAt: timestamp,
      leaseOwner: "test-worker",
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
      lastError: null,
    };
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(executor.execute(effect, { willRetry: true }))),
      );
      assert.deepEqual(yield* Ref.get(recovered), []);
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(executor.execute(effect, { willRetry: false }))),
      );
      assert.deepEqual(yield* Ref.get(recovered), [threadId]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect.each(["confirmed", "unconfirmed", "failed"] as const)(
  "a native subagent stop only repairs %s provider evidence",
  (outcome) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const layer = layerExecutorFor({
        events,
        interrupt: (input) => {
          assert.equal(input.subagent?.nativeTaskId, "native-task");
          return Ref.update(events, (current) => [...current, "stop-child"]).pipe(
            Effect.andThen(
              outcome === "failed"
                ? new ProviderTurnControlService.ProviderTurnControlError({
                    threadId,
                    providerTurnId,
                    operation: "interrupt",
                    cause: "SDK stop failed",
                  })
                : Effect.succeed(
                    outcome === "confirmed"
                      ? {
                          status: "cancelled" as const,
                          completedAt: now,
                          result: "Stopped by Claude",
                        }
                      : undefined,
                  ),
            ),
          );
        },
        threads: {
          dispatch: (command) => {
            assert.equal(command.type, "thread.background-work.settle");
            if (command.type === "thread.background-work.settle") {
              assert.equal(command.subagent?.id, "subagent");
              assert.deepEqual(command.subagent?.outcome, {
                status: "cancelled",
                completedAt: now,
                result: "Stopped by Claude",
              });
            }
            return Ref.update(events, (current) => [...current, "settle-child"]).pipe(
              Effect.as({ sequence: 1, storedEvents: [] }),
            );
          },
        },
      });
      const execution = yield* Effect.gen(function* () {
        const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
        yield* executor.execute({
          ...restartEffect(now, { type: "detach" }),
          request: {
            type: "provider-turn.interrupt",
            providerSessionId: oldSessionId,
            providerThreadId,
            providerTurnId,
            subagent: { id: NodeId.make("subagent"), nativeTaskId: "native-task" },
          },
        });
      }).pipe(Effect.provide(layer), Effect.exit);
      assert.equal(Exit.isFailure(execution), outcome === "failed");
      assert.deepEqual(
        yield* Ref.get(events),
        outcome === "confirmed" ? ["stop-child", "settle-child"] : ["stop-child"],
      );
    }),
);
