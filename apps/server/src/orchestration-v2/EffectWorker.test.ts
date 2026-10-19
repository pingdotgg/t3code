import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  NodeId,
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
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
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
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";

const threadId = ThreadId.make("thread:effect-worker-restart");
const oldSessionId = ProviderSessionId.make("provider-session:effect-worker-restart:old");
const providerThreadId = ProviderThreadId.make("provider-thread:effect-worker-restart");
const providerTurnId = ProviderTurnId.make("provider-turn:effect-worker-restart");
const attemptId = RunAttemptId.make("run-attempt:effect-worker-restart");
const runId = RunId.make("run:effect-worker-restart");

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

it.effect(
  "releases four expired leases while preserving ownership, ordering, and late settlement",
  () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const hung = yield* Effect.forEach(
        ["failure", "success", "retry", "cancellation"] as const,
        (outcome, index) =>
          Effect.gen(function* () {
            return {
              outcome,
              id: `effect:a-hung-${index}`,
              commandId: CommandId.make(`command:hung-${index}`),
              threadId: ThreadId.make(`thread:hung-${index}`),
              request:
                index % 2 === 0
                  ? { type: "provider-turn.start" as const, runId }
                  : {
                      type: "provider-turn.interrupt" as const,
                      providerSessionId: oldSessionId,
                      providerThreadId,
                      providerTurnId,
                    },
              started: yield* Deferred.make<void>(),
            };
          }),
      );
      const unrelated = {
        id: "effect:b-unrelated",
        commandId: CommandId.make("command:unrelated"),
        threadId: ThreadId.make("thread:unrelated"),
        request: { type: "terminal.cleanup" as const },
      };
      const followUps = hung.map((effect, index) => ({
        ...unrelated,
        id: `effect:c-follow-up-${index}`,
        threadId: effect.threadId,
      }));
      yield* outbox.enqueue([...hung, unrelated, ...followUps]);
      // Give one row a prior attempt so the same worker exercises exhausted and retryable failures.
      const prior = yield* outbox.claimNext({ workerId: "previous", leaseDurationMs: 1_000 });
      assert.equal(Option.getOrThrow(prior).id, hung[0]!.id);
      assert.isTrue(
        yield* outbox.retry({
          effectId: hung[0]!.id,
          workerId: "previous",
          error: "previous provider failure",
          delayMs: 0,
        }),
      );
      const providerAnswer = yield* Deferred.make<void>();
      const cancelledExecution = yield* Deferred.make<void>();
      const retryScheduled = yield* Deferred.make<void>();
      const unrelatedStarted = yield* Deferred.make<void>();
      const executions = yield* Ref.make<ReadonlyArray<string>>([]);
      const layerExecutor = Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, {
        execute: (effect) =>
          Effect.gen(function* () {
            yield* Ref.update(executions, (ids) => [...ids, effect.id]);
            const pending = hung.find(({ id }) => id === effect.id);
            if (pending === undefined) {
              if (effect.id === unrelated.id) yield* Deferred.succeed(unrelatedStarted, undefined);
              return;
            }
            if (pending.outcome === "retry" && effect.attemptCount === 2) return;
            yield* Deferred.succeed(pending.started, undefined);
            yield* Deferred.await(providerAnswer).pipe(
              Effect.onInterrupt(() => Deferred.succeed(cancelledExecution, undefined)),
            );
            if (pending.outcome === "failure" || pending.outcome === "retry") {
              return yield* new EffectWorker.OrchestrationEffectExecutionError({
                effectId: effect.id,
                effectType: effect.request.type,
                cause: "late provider failure",
              });
            }
          }),
      });
      const layerOutbox = Layer.succeed(EffectOutbox.EffectOutboxV2, {
        ...outbox,
        retry: (input) =>
          outbox.retry(input).pipe(Effect.tap(() => Deferred.succeed(retryScheduled, undefined))),
      });
      const layerWorker = EffectWorker.layerWithOptions({
        workerId: "lease-worker",
        leaseDurationMs: 1_000,
        maxAttempts: 2,
      }).pipe(Layer.provide(Layer.merge(layerOutbox, layerExecutor)));
      yield* EffectWorker.runDaemon.pipe(Effect.provide(layerWorker), Effect.forkScoped);
      yield* Effect.forEach(hung, ({ started }) => Deferred.await(started));
      yield* TestClock.adjust("999 millis");
      assert.isFalse(yield* Deferred.isDone(unrelatedStarted));
      yield* TestClock.adjust("1 millis");
      assert.isTrue(yield* Deferred.isDone(unrelatedStarted));
      yield* outbox.awaitSettled(unrelated.id);

      yield* TestClock.adjust("60 seconds");
      for (const effect of hung) {
        const row = Option.getOrThrow(yield* outbox.get(effect.id));
        assert.equal(row.status, "running");
        assert.equal(row.leaseOwner, "lease-worker");
        assert.equal(row.attemptCount, effect.outcome === "failure" ? 2 : 1);
      }
      for (const followUp of followUps) {
        assert.equal(Option.getOrThrow(yield* outbox.get(followUp.id)).status, "pending");
      }
      assert.sameMembers(
        [...(yield* Ref.get(executions))],
        [...hung.map(({ id }) => id), unrelated.id],
      );
      assert.isFalse(yield* Deferred.isDone(cancelledExecution));

      const cancelled = hung[3]!;
      yield* outbox
        .cancelUnsettled({
          threadId: cancelled.threadId,
          effectTypes: [cancelled.request.type],
          reason: "stopped after lease expiry",
        })
        .pipe(Effect.flatMap(outbox.signalCancellations));
      yield* Deferred.await(cancelledExecution);
      yield* Deferred.succeed(providerAnswer, undefined);
      yield* Deferred.await(retryScheduled);
      assert.equal(Option.getOrThrow(yield* outbox.get(followUps[2]!.id)).status, "pending");
      yield* TestClock.adjust("100 millis");
      yield* Effect.forEach([...hung, ...followUps], ({ id }) => outbox.awaitSettled(id));
      yield* TestClock.adjust("60 seconds");
      for (const effect of hung) {
        const row = Option.getOrThrow(yield* outbox.get(effect.id));
        assert.equal(
          row.status,
          effect.outcome === "cancellation"
            ? "cancelled"
            : effect.outcome === "failure"
              ? "failed"
              : "succeeded",
        );
        assert.equal(
          row.attemptCount,
          effect.outcome === "failure" || effect.outcome === "retry" ? 2 : 1,
        );
        assert.isNull(row.leaseOwner);
      }
      assert.sameMembers(
        [...(yield* Ref.get(executions))],
        [...hung.map(({ id }) => id), unrelated.id, hung[2]!.id, ...followUps.map(({ id }) => id)],
      );
    }).pipe(
      Effect.provide(
        Layer.merge(
          EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
          TestClock.layer(),
        ),
      ),
    ),
);

it.effect("closes the worker layer with overdue effects and recovers the remaining rows", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const effects = [
      {
        id: "effect:a-provider",
        commandId: CommandId.make("command:shutdown"),
        threadId,
        request: { type: "provider-turn.start" as const, runId },
      },
      {
        id: "effect:b-cleanup",
        commandId: CommandId.make("command:shutdown"),
        threadId: ThreadId.make("thread:cleanup"),
        request: { type: "terminal.cleanup" as const },
      },
    ];
    const followUp = { ...effects[1]!, id: "effect:c-follow-up", threadId };
    yield* outbox.enqueue([...effects, followUp]);
    const started = yield* Effect.forEach(effects, () => Deferred.make<void>());
    const interrupted = yield* Effect.forEach(effects, () => Deferred.make<void>());
    const providerAnswer = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    const closed = yield* Deferred.make<void>();
    const workerScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    const layerExecutor = Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, {
      execute: (effect) => {
        const index = effects.findIndex(({ id }) => id === effect.id);
        return Deferred.succeed(started[index]!, undefined).pipe(
          Effect.andThen(Deferred.await(providerAnswer)),
          Effect.onInterrupt(() => Deferred.succeed(interrupted[index]!, undefined)),
        );
      },
    });
    const context = yield* Layer.buildWithScope(
      EffectWorker.layerWithOptions({ leaseDurationMs: 1_000 }).pipe(Layer.provide(layerExecutor)),
      workerScope,
    );
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.provideContext(context),
    );
    yield* Effect.all(
      effects.map(() => worker.runOnce),
      { concurrency: "unbounded" },
    ).pipe(Effect.andThen(Deferred.succeed(released, undefined)), Effect.forkScoped);
    yield* Effect.forEach(started, Deferred.await);
    yield* TestClock.adjust("1 second");
    assert.isTrue(yield* Deferred.isDone(released));
    for (const signal of interrupted) assert.isFalse(yield* Deferred.isDone(signal));

    yield* Scope.close(workerScope, Exit.void).pipe(
      Effect.andThen(Deferred.succeed(closed, undefined)),
      Effect.forkScoped,
    );
    yield* TestClock.adjust(0);
    assert.isTrue(yield* Deferred.isDone(closed));
    for (const signal of interrupted) assert.isTrue(yield* Deferred.isDone(signal));
    assert.isFalse(yield* Deferred.isDone(providerAnswer));
    for (const effect of effects) {
      assert.equal(Option.getOrThrow(yield* outbox.get(effect.id)).status, "running");
    }
    assert.deepEqual(yield* outbox.reconcileAfterProcessLoss, { requeued: 1, cancelled: 1 });
    const recovered = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((recoveryWorker) => recoveryWorker.drain()),
      Effect.provide(
        EffectWorker.layerWithOptions({ workerId: "replacement" }).pipe(
          Layer.provide(
            Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, {
              execute: (effect) => Ref.update(recovered, (ids) => [...ids, effect.id]),
            }),
          ),
        ),
      ),
    );
    assert.sameMembers([...(yield* Ref.get(recovered))], [effects[1]!.id, followUp.id]);
    assert.equal(Option.getOrThrow(yield* outbox.get(effects[0]!.id)).status, "cancelled");
    for (const id of [effects[1]!.id, followUp.id]) {
      assert.equal(Option.getOrThrow(yield* outbox.get(id)).status, "succeeded");
    }
  }).pipe(
    Effect.provide(
      Layer.merge(
        EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
        TestClock.layer(),
      ),
    ),
  ),
);

it.effect("interrupts overdue executions with the daemon while the worker layer stays open", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const provider = {
      id: "effect:a-daemon-provider",
      commandId: CommandId.make("command:daemon-shutdown"),
      threadId,
      request: { type: "provider-turn.start" as const, runId },
    };
    const unrelated = {
      ...provider,
      id: "effect:b-daemon-unrelated",
      threadId: ThreadId.make("thread:daemon-unrelated"),
      request: { type: "terminal.cleanup" as const },
    };
    const followUp = { ...unrelated, id: "effect:c-daemon-follow-up", threadId };
    yield* outbox.enqueue([provider, unrelated, followUp]);
    const started = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const providerAnswer = yield* Deferred.make<void>();
    const cleanupStarted = yield* Deferred.make<void>();
    const cleanupAnswer = yield* Deferred.make<void>();
    const layerExecutor = Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, {
      execute: (effect) =>
        effect.id === provider.id
          ? Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(providerAnswer)),
              Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
            )
          : effect.id === followUp.id
            ? Deferred.succeed(cleanupStarted, undefined).pipe(
                Effect.andThen(Deferred.await(cleanupAnswer)),
              )
            : Effect.void,
    });
    const context = yield* Layer.build(
      EffectWorker.layerWithOptions({ leaseDurationMs: 1_000 }).pipe(Layer.provide(layerExecutor)),
    );
    const daemon = yield* EffectWorker.runDaemonWithOptions({ concurrency: 1 }).pipe(
      Effect.provideContext(context),
      Effect.forkScoped,
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust("1 second");
    yield* outbox.awaitSettled(unrelated.id);
    assert.isFalse(yield* Deferred.isDone(interrupted));
    assert.equal(Option.getOrThrow(yield* outbox.get(followUp.id)).status, "pending");

    yield* Fiber.interrupt(daemon);
    assert.isTrue(yield* Deferred.isDone(interrupted));
    assert.isFalse(yield* Deferred.isDone(providerAnswer));
    assert.equal(Option.getOrThrow(yield* outbox.get(provider.id)).status, "running");
    assert.deepEqual(yield* outbox.reconcileAfterProcessLoss, { requeued: 0, cancelled: 1 });
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.provideContext(context),
    );
    const drained = yield* Deferred.make<void>();
    const draining = yield* worker.drain().pipe(
      Effect.tap(() => Deferred.succeed(drained, undefined)),
      Effect.forkScoped,
    );
    yield* Deferred.await(cleanupStarted);
    yield* TestClock.adjust("1 second");
    assert.isFalse(yield* Deferred.isDone(drained));
    yield* Deferred.succeed(cleanupAnswer, undefined);
    assert.equal(yield* Fiber.join(draining), 1);
    assert.equal(Option.getOrThrow(yield* outbox.get(followUp.id)).status, "succeeded");
  }).pipe(
    Effect.provide(
      Layer.merge(
        EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
        TestClock.layer(),
      ),
    ),
  ),
);
