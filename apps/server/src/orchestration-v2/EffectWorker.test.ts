import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { CheckpointRollbackServiceV2 } from "./CheckpointRollbackService.ts";
import {
  EffectOutboxV2,
  PENDING_TERMINALIZATION_MARKER,
  type OrchestrationEffectV2,
} from "./EffectOutbox.ts";
import {
  executorLayer,
  isNonRetryableProviderTurnControlFailure,
  isNonRetryableProviderTurnStartPrerequisiteFailure,
  layerWithOptions as effectWorkerLayerWithOptions,
  OrchestrationEffectExecutionError,
  OrchestrationEffectExecutorV2,
  OrchestrationEffectWorkerV2,
} from "./EffectWorker.ts";
import { RunFinalizationService } from "./RunFinalizationService.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { ProviderTurnControlServiceV2 } from "./ProviderTurnControlService.ts";
import {
  canTerminalizeProviderTurnStartFailure,
  ProviderTurnStartError,
  ProviderTurnStartServiceV2,
} from "./ProviderTurnStartService.ts";
import { RuntimeRequestServiceV2 } from "./RuntimeRequestService.ts";

const threadId = ThreadId.make("thread:effect-worker-restart");
const oldSessionId = ProviderSessionId.make("provider-session:effect-worker-restart:old");
const replacementSessionId = ProviderSessionId.make(
  "provider-session:effect-worker-restart:replacement",
);
const providerThreadId = ProviderThreadId.make("provider-thread:effect-worker-restart");
const providerTurnId = ProviderTurnId.make("provider-turn:effect-worker-restart");
const attemptId = RunAttemptId.make("run-attempt:effect-worker-restart");
const runId = RunId.make("run:effect-worker-restart");

function restartEffect(
  now: DateTime.Utc,
  sessionTransition: NonNullable<
    Extract<
      OrchestrationEffectV2["request"],
      { readonly type: "provider-turn.restart" }
    >["sessionTransition"]
  >,
): OrchestrationEffectV2 {
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
    leaseExpiresAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    lastError: null,
  };
}

function makeExecutorLayer(input: {
  readonly events: Ref.Ref<ReadonlyArray<string>>;
  readonly failFirstStart?: Ref.Ref<boolean>;
}) {
  const record = (event: string) => Ref.update(input.events, (events) => [...events, event]);
  const dependencies = Layer.mergeAll(
    Layer.succeed(
      ProviderTurnControlServiceV2,
      ProviderTurnControlServiceV2.of({
        interrupt: () => Effect.void,
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
      ProviderSessionManagerV2,
      ProviderSessionManagerV2.of({
        shutdown: Effect.void,
        open: () => Effect.die("unused open"),
        get: () => Effect.succeed(Option.none()),
        close: () => Effect.void,
        release: () => record("release"),
        detach: () => record("detach"),
      }),
    ),
    Layer.succeed(
      ProviderTurnStartServiceV2,
      ProviderTurnStartServiceV2.of({
        start: () =>
          Effect.gen(function* () {
            yield* record("start");
            if (
              input.failFirstStart !== undefined &&
              (yield* Ref.getAndSet(input.failFirstStart, false))
            ) {
              return yield* new ProviderTurnStartError({
                runId,
                cause: "simulated first start failure",
              });
            }
          }),
        failPermanently: () => record("fail-permanently"),
      }),
    ),
    Layer.succeed(
      RunFinalizationService,
      RunFinalizationService.of({ finalize: () => Effect.void }),
    ),
    Layer.succeed(
      CheckpointRollbackServiceV2,
      CheckpointRollbackServiceV2.of({ execute: () => Effect.void }),
    ),
    Layer.succeed(
      RuntimeRequestServiceV2,
      RuntimeRequestServiceV2.of({ respond: () => Effect.void }),
    ),
  );
  return executorLayer.pipe(Layer.provide(dependencies));
}

it("does not retry pure interrupt races where the turn is already gone", () => {
  assert.isTrue(
    isNonRetryableProviderTurnControlFailure(
      "provider-turn.interrupt",
      "ProviderAdapterInterruptError: ... ACP provider turn provider-turn:x is not active",
    ),
  );
  assert.isTrue(
    isNonRetryableProviderTurnControlFailure(
      "provider-turn.interrupt",
      "Provider session provider-session:x is not active.",
    ),
  );
  // Restart is compound (interrupt + detach + start). Do not swallow start failures.
  assert.isFalse(
    isNonRetryableProviderTurnControlFailure(
      "provider-turn.restart",
      "Provider session provider-session:x is not active.",
    ),
  );
  assert.isFalse(
    isNonRetryableProviderTurnControlFailure(
      "provider-turn.start",
      "Provider session provider-session:x is not active.",
    ),
  );
  assert.isFalse(
    isNonRetryableProviderTurnControlFailure(
      "provider-turn.interrupt",
      "ACP hard teardown failed unexpectedly; the session is poisoned",
    ),
  );
});

it("classifies checkpoint baseline prerequisites as non-retryable start failures", () => {
  assert.isTrue(
    isNonRetryableProviderTurnStartPrerequisiteFailure(
      "provider-turn.start",
      "CheckpointBaselineCaptureError: Failed to capture checkpoint baseline 0",
    ),
  );
  assert.isFalse(
    isNonRetryableProviderTurnStartPrerequisiteFailure(
      "provider-turn.interrupt",
      "CheckpointBaselineCaptureError: Failed to capture checkpoint baseline 0",
    ),
  );
  assert.isTrue(canTerminalizeProviderTurnStartFailure("starting"));
  assert.isTrue(canTerminalizeProviderTurnStartFailure("running"));
  assert.isFalse(canTerminalizeProviderTurnStartFailure("completed"));
});

it.effect("detaches a handed-off session only after the old turn terminalizes", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const events = yield* Ref.make<ReadonlyArray<string>>([]);

    yield* Effect.gen(function* () {
      const executor = yield* OrchestrationEffectExecutorV2;
      yield* executor.execute(restartEffect(now, { type: "detach" }));
    }).pipe(Effect.provide(makeExecutorLayer({ events })));

    assert.deepEqual(yield* Ref.get(events), ["interrupt", "detach", "start"]);
  }),
);

it.effect("safely retries after replacement cleanup succeeds and start fails", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const failFirstStart = yield* Ref.make(true);
    const effect = restartEffect(now, {
      type: "replace",
      replacementProviderSessionId: replacementSessionId,
    });
    const layer = makeExecutorLayer({ events, failFirstStart });

    const first = yield* Effect.gen(function* () {
      const executor = yield* OrchestrationEffectExecutorV2;
      return yield* Effect.exit(executor.execute(effect));
    }).pipe(Effect.provide(layer));
    assert.isTrue(Exit.isFailure(first));

    yield* Effect.gen(function* () {
      const executor = yield* OrchestrationEffectExecutorV2;
      yield* executor.execute(effect);
    }).pipe(Effect.provide(layer));

    assert.deepEqual(yield* Ref.get(events), [
      `interrupt:${replacementSessionId}`,
      "detach",
      "start",
      `interrupt:${replacementSessionId}`,
      "detach",
      "start",
    ]);
  }),
);

it.effect("routes exhausted restart effects to permanent start failure handling", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const events = yield* Ref.make<ReadonlyArray<string>>([]);

    yield* Effect.gen(function* () {
      const executor = yield* OrchestrationEffectExecutorV2;
      assert.isDefined(executor.handlePermanentFailure);
      yield* executor.handlePermanentFailure?.(restartEffect(now, { type: "detach" }));
    }).pipe(Effect.provide(makeExecutorLayer({ events })));

    assert.deepEqual(yield* Ref.get(events), ["fail-permanently"]);
  }),
);

it.effect("projects permanent failure before failing an exhausted outbox effect", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (event: string) => Ref.update(events, (current) => [...current, event]);
    const effect = {
      ...restartEffect(now, { type: "detach" }),
      attemptCount: 5,
      leaseOwner: "permanent-failure-worker",
    };
    const outboxLayer = Layer.mock(EffectOutboxV2)({
      claimNext: () => Effect.succeed(Option.some(effect)),
      get: () => Effect.succeed(Option.some(effect)),
      awaitCancellation: () => Effect.never,
      clearCancellation: () => Effect.void,
      fail: () => record("outbox-fail").pipe(Effect.as(true)),
    });
    const executorLayer = Layer.succeed(
      OrchestrationEffectExecutorV2,
      OrchestrationEffectExecutorV2.of({
        execute: () =>
          record("execute").pipe(
            Effect.andThen(
              Effect.fail(
                new OrchestrationEffectExecutionError({
                  effectId: effect.id,
                  effectType: effect.request.type,
                  cause: "simulated transport failure",
                }),
              ),
            ),
          ),
        handlePermanentFailure: () => record("terminalize"),
      }),
    );
    const workerLayer = effectWorkerLayerWithOptions({
      workerId: "permanent-failure-worker",
      maxAttempts: 5,
    }).pipe(Layer.provide(Layer.merge(outboxLayer, executorLayer)));

    assert.isTrue(
      yield* OrchestrationEffectWorkerV2.pipe(
        Effect.flatMap((worker) => worker.runOnce),
        Effect.provide(workerLayer),
      ),
    );
    assert.deepEqual(yield* Ref.get(events), ["execute", "terminalize", "outbox-fail"]);
  }),
);

it.effect("terminalizes a non-retryable checkpoint prerequisite on its first attempt", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (event: string) => Ref.update(events, (current) => [...current, event]);
    const effect = {
      ...restartEffect(now, { type: "detach" }),
      leaseOwner: "checkpoint-prerequisite-worker",
    };
    const outboxLayer = Layer.mock(EffectOutboxV2)({
      claimNext: () => Effect.succeed(Option.some(effect)),
      get: () => Effect.succeed(Option.some(effect)),
      awaitCancellation: () => Effect.never,
      clearCancellation: () => Effect.void,
      fail: () => record("outbox-fail").pipe(Effect.as(true)),
    });
    const executorLayer = Layer.succeed(
      OrchestrationEffectExecutorV2,
      OrchestrationEffectExecutorV2.of({
        execute: () =>
          Effect.fail(
            new OrchestrationEffectExecutionError({
              effectId: effect.id,
              effectType: effect.request.type,
              cause: "CheckpointBaselineCaptureError: Failed to capture checkpoint baseline 0",
            }),
          ),
        handlePermanentFailure: () => record("terminalize"),
      }),
    );
    const workerLayer = effectWorkerLayerWithOptions({
      workerId: "checkpoint-prerequisite-worker",
      maxAttempts: 5,
    }).pipe(Layer.provide(Layer.merge(outboxLayer, executorLayer)));

    assert.isTrue(
      yield* OrchestrationEffectWorkerV2.pipe(
        Effect.flatMap((worker) => worker.runOnce),
        Effect.provide(workerLayer),
      ),
    );
    assert.deepEqual(yield* Ref.get(events), ["terminalize", "outbox-fail"]);
  }),
);

it.effect("retries instead of failing the outbox effect when terminal projection fails", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (event: string) => Ref.update(events, (current) => [...current, event]);
    const effect = {
      ...restartEffect(now, { type: "detach" }),
      attemptCount: 5,
      leaseOwner: "projection-retry-worker",
    };
    const retryErrors: Array<string> = [];
    const outboxLayer = Layer.mock(EffectOutboxV2)({
      claimNext: () => Effect.succeed(Option.some(effect)),
      get: () => Effect.succeed(Option.some(effect)),
      awaitCancellation: () => Effect.never,
      clearCancellation: () => Effect.void,
      fail: () => record("outbox-fail").pipe(Effect.as(true)),
      retry: ({ error }) =>
        Effect.sync(() => {
          retryErrors.push(error);
        }).pipe(Effect.andThen(record("outbox-retry")), Effect.as(true)),
    });
    const executorLayer = Layer.succeed(
      OrchestrationEffectExecutorV2,
      OrchestrationEffectExecutorV2.of({
        execute: () =>
          Effect.fail(
            new OrchestrationEffectExecutionError({
              effectId: effect.id,
              effectType: effect.request.type,
              cause: "simulated transport failure",
            }),
          ),
        handlePermanentFailure: () =>
          record("terminalize").pipe(
            Effect.andThen(
              Effect.fail(
                new OrchestrationEffectExecutionError({
                  effectId: effect.id,
                  effectType: effect.request.type,
                  cause: "simulated projection store failure",
                }),
              ),
            ),
          ),
      }),
    );
    const workerLayer = effectWorkerLayerWithOptions({
      workerId: "projection-retry-worker",
      maxAttempts: 5,
    }).pipe(Layer.provide(Layer.merge(outboxLayer, executorLayer)));

    assert.isTrue(
      yield* OrchestrationEffectWorkerV2.pipe(
        Effect.flatMap((worker) => worker.runOnce),
        Effect.provide(workerLayer),
      ),
    );
    assert.deepEqual(yield* Ref.get(events), ["terminalize", "outbox-retry"]);
    assert.equal(retryErrors.length, 1);
    assert.isTrue(retryErrors[0]?.startsWith(PENDING_TERMINALIZATION_MARKER));
  }),
);

it.effect("only retries the terminal projection when reclaiming a pending terminalization", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (event: string) => Ref.update(events, (current) => [...current, event]);
    const effect = {
      ...restartEffect(now, { type: "detach" }),
      attemptCount: 2,
      leaseOwner: "pending-terminalization-worker",
      lastError: `${PENDING_TERMINALIZATION_MARKER}simulated transport failure`,
    };
    const outboxLayer = Layer.mock(EffectOutboxV2)({
      claimNext: () => Effect.succeed(Option.some(effect)),
      get: () => Effect.succeed(Option.some(effect)),
      awaitCancellation: () => Effect.never,
      clearCancellation: () => Effect.void,
      fail: ({ error }) => record(`outbox-fail:${error}`).pipe(Effect.as(true)),
    });
    const executorLayer = Layer.succeed(
      OrchestrationEffectExecutorV2,
      OrchestrationEffectExecutorV2.of({
        execute: () => record("execute").pipe(Effect.asVoid),
        handlePermanentFailure: () => record("terminalize"),
      }),
    );
    const workerLayer = effectWorkerLayerWithOptions({
      workerId: "pending-terminalization-worker",
      maxAttempts: 5,
    }).pipe(Layer.provide(Layer.merge(outboxLayer, executorLayer)));

    assert.isTrue(
      yield* OrchestrationEffectWorkerV2.pipe(
        Effect.flatMap((worker) => worker.runOnce),
        Effect.provide(workerLayer),
      ),
    );
    // The provider execution never re-runs; only the projection is retried.
    assert.deepEqual(yield* Ref.get(events), [
      "terminalize",
      "outbox-fail:simulated transport failure",
    ]);
  }),
);

it.effect("does not project a permanent failure after losing the effect lease", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (event: string) => Ref.update(events, (current) => [...current, event]);
    const claimed = {
      ...restartEffect(now, { type: "detach" }),
      attemptCount: 5,
      leaseOwner: "stale-worker",
    };
    const reclaimed = { ...claimed, leaseOwner: "other-worker" };
    const outboxLayer = Layer.mock(EffectOutboxV2)({
      claimNext: () => Effect.succeed(Option.some(claimed)),
      get: () => Effect.succeed(Option.some(reclaimed)),
      awaitCancellation: () => Effect.never,
      clearCancellation: () => Effect.void,
      fail: () => record("outbox-fail").pipe(Effect.as(false)),
    });
    const executorLayer = Layer.succeed(
      OrchestrationEffectExecutorV2,
      OrchestrationEffectExecutorV2.of({
        execute: () =>
          Effect.fail(
            new OrchestrationEffectExecutionError({
              effectId: claimed.id,
              effectType: claimed.request.type,
              cause: "simulated transport failure",
            }),
          ),
        handlePermanentFailure: () => record("terminalize"),
      }),
    );
    const workerLayer = effectWorkerLayerWithOptions({
      workerId: "stale-worker",
      maxAttempts: 5,
    }).pipe(Layer.provide(Layer.merge(outboxLayer, executorLayer)));

    const result = yield* OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce),
      Effect.provide(workerLayer),
      Effect.exit,
    );
    assert.isTrue(Exit.isFailure(result));
    assert.deepEqual(yield* Ref.get(events), ["outbox-fail"]);
  }),
);
