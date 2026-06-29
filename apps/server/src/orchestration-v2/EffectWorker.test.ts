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
import type { OrchestrationEffectV2 } from "./EffectOutbox.ts";
import { executorLayer, OrchestrationEffectExecutorV2 } from "./EffectWorker.ts";
import { RunFinalizationService } from "./RunFinalizationService.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { ProviderTurnControlServiceV2 } from "./ProviderTurnControlService.ts";
import { ProviderTurnStartError, ProviderTurnStartServiceV2 } from "./ProviderTurnStartService.ts";
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
