import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { CheckpointCaptureServiceV2 } from "./CheckpointCaptureService.ts";
import { EffectOutboxV2, type OrchestrationEffectV2 } from "./EffectOutbox.ts";
import { CheckpointRollbackServiceV2 } from "./CheckpointRollbackService.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { ProviderTurnControlServiceV2 } from "./ProviderTurnControlService.ts";
import { ProviderTurnStartServiceV2 } from "./ProviderTurnStartService.ts";
import { RuntimeRequestServiceV2 } from "./RuntimeRequestService.ts";

export class OrchestrationEffectExecutionError extends Schema.TaggedErrorClass<OrchestrationEffectExecutionError>()(
  "OrchestrationEffectExecutionError",
  {
    effectId: Schema.String,
    effectType: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface OrchestrationEffectExecutorV2Shape {
  readonly execute: (
    effect: OrchestrationEffectV2,
  ) => Effect.Effect<void, OrchestrationEffectExecutionError>;
}

export class OrchestrationEffectExecutorV2 extends Context.Service<
  OrchestrationEffectExecutorV2,
  OrchestrationEffectExecutorV2Shape
>()("t3/orchestration-v2/EffectWorker/OrchestrationEffectExecutorV2") {}

export const executorLayer: Layer.Layer<
  OrchestrationEffectExecutorV2,
  never,
  | ProviderSessionManagerV2
  | CheckpointCaptureServiceV2
  | CheckpointRollbackServiceV2
  | ProviderTurnControlServiceV2
  | ProviderTurnStartServiceV2
  | RuntimeRequestServiceV2
> = Layer.effect(
  OrchestrationEffectExecutorV2,
  Effect.gen(function* () {
    const checkpointCapture = yield* CheckpointCaptureServiceV2;
    const checkpointRollback = yield* CheckpointRollbackServiceV2;
    const providerSessions = yield* ProviderSessionManagerV2;
    const providerTurnControl = yield* ProviderTurnControlServiceV2;
    const providerTurnStart = yield* ProviderTurnStartServiceV2;
    const runtimeRequests = yield* RuntimeRequestServiceV2;
    return OrchestrationEffectExecutorV2.of({
      execute: (effect) => {
        switch (effect.request.type) {
          case "provider-session.detach":
            return providerSessions
              .detach({
                providerSessionId: effect.request.providerSessionId,
                threadId: effect.threadId,
                ...(effect.request.detail === undefined ? {} : { detail: effect.request.detail }),
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          case "provider-turn.start":
            return providerTurnStart
              .start({ threadId: effect.threadId, runId: effect.request.runId })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          case "provider-turn.interrupt":
            return providerTurnControl
              .interrupt({
                threadId: effect.threadId,
                providerSessionId: effect.request.providerSessionId,
                providerThreadId: effect.request.providerThreadId,
                providerTurnId: effect.request.providerTurnId,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          case "provider-turn.steer":
            return providerTurnControl
              .steer({
                threadId: effect.threadId,
                providerSessionId: effect.request.providerSessionId,
                providerThreadId: effect.request.providerThreadId,
                providerTurnId: effect.request.providerTurnId,
                messageId: effect.request.messageId,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          case "provider-turn.restart":
            return providerTurnControl
              .interruptAndAwaitTerminal({
                threadId: effect.threadId,
                providerSessionId: effect.request.providerSessionId,
                providerThreadId: effect.request.providerThreadId,
                providerTurnId: effect.request.providerTurnId,
                interruptedAttemptId: effect.request.interruptedAttemptId,
              })
              .pipe(
                Effect.andThen(
                  providerTurnStart.start({
                    threadId: effect.threadId,
                    runId: effect.request.runId,
                  }),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          case "runtime-request.respond":
            return runtimeRequests
              .respond({
                threadId: effect.threadId,
                providerSessionId: effect.request.providerSessionId,
                requestId: effect.request.requestId,
                ...(effect.request.decision === undefined
                  ? {}
                  : { decision: effect.request.decision }),
                ...(effect.request.answers === undefined
                  ? {}
                  : { answers: effect.request.answers }),
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          case "provider-thread.rollback":
            return checkpointRollback
              .execute({
                threadId: effect.threadId,
                providerThreadId: effect.request.providerThreadId,
                checkpointId: effect.request.checkpointId,
                scopeId: effect.request.scopeId,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          case "checkpoint.capture":
            return checkpointCapture
              .execute({
                threadId: effect.threadId,
                runId: effect.request.runId,
                scopeId: effect.request.scopeId,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          case "provider-thread.fork":
          case "terminal.cleanup":
          case "attachment.cleanup":
            return Effect.fail(
              new OrchestrationEffectExecutionError({
                effectId: effect.id,
                effectType: effect.request.type,
                cause: `No Shape 1 executor is registered for ${effect.request.type}.`,
              }),
            );
        }
      },
    });
  }),
);

export class OrchestrationEffectWorkerError extends Schema.TaggedErrorClass<OrchestrationEffectWorkerError>()(
  "OrchestrationEffectWorkerError",
  {
    operation: Schema.String,
    effectId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface OrchestrationEffectWorkerV2Shape {
  readonly awaitWork: Effect.Effect<void>;
  readonly runOnce: Effect.Effect<boolean, OrchestrationEffectWorkerError>;
  readonly drain: (maxEffects?: number) => Effect.Effect<number, OrchestrationEffectWorkerError>;
}

export class OrchestrationEffectWorkerV2 extends Context.Service<
  OrchestrationEffectWorkerV2,
  OrchestrationEffectWorkerV2Shape
>()("t3/orchestration-v2/EffectWorker/OrchestrationEffectWorkerV2") {}

export interface OrchestrationEffectWorkerOptions {
  readonly workerId?: string;
  readonly leaseDurationMs?: number;
  readonly maxAttempts?: number;
}

export const layerWithOptions = (
  options: OrchestrationEffectWorkerOptions = {},
): Layer.Layer<
  OrchestrationEffectWorkerV2,
  never,
  EffectOutboxV2 | OrchestrationEffectExecutorV2
> =>
  Layer.effect(
    OrchestrationEffectWorkerV2,
    Effect.gen(function* () {
      const outbox = yield* EffectOutboxV2;
      const executor = yield* OrchestrationEffectExecutorV2;
      const workerId = options.workerId ?? `orchestration-v2:${process.pid}`;
      const leaseDurationMs = Math.max(1, options.leaseDurationMs ?? 30_000);
      const maxAttempts = Math.max(1, options.maxAttempts ?? 5);

      const runOnce = Effect.gen(function* () {
        const claimed = yield* outbox.claimNext({ workerId, leaseDurationMs });
        if (Option.isNone(claimed)) {
          return false;
        }
        const effect = claimed.value;
        const exit = yield* Effect.exit(executor.execute(effect));
        if (Exit.isSuccess(exit)) {
          const completed = yield* outbox.succeed({ effectId: effect.id, workerId });
          if (!completed) {
            return yield* new OrchestrationEffectWorkerError({
              operation: "complete",
              effectId: effect.id,
              cause: "The worker no longer owns the effect lease.",
            });
          }
          return true;
        }

        const error = Cause.pretty(exit.cause);
        yield* Effect.logWarning("Orchestration effect execution failed", {
          effectId: effect.id,
          effectType: effect.request.type,
          attemptCount: effect.attemptCount,
          error,
        });
        const updated =
          effect.attemptCount >= maxAttempts
            ? yield* outbox.fail({ effectId: effect.id, workerId, error })
            : yield* outbox.retry({
                effectId: effect.id,
                workerId,
                error,
                delayMs: Math.min(30_000, 100 * 2 ** Math.max(0, effect.attemptCount - 1)),
              });
        if (!updated) {
          return yield* new OrchestrationEffectWorkerError({
            operation: "reschedule",
            effectId: effect.id,
            cause: "The worker no longer owns the effect lease.",
          });
        }
        return true;
      }).pipe(
        Effect.mapError((cause) =>
          Schema.is(OrchestrationEffectWorkerError)(cause)
            ? cause
            : new OrchestrationEffectWorkerError({ operation: "run", cause }),
        ),
      );

      return OrchestrationEffectWorkerV2.of({
        awaitWork: outbox.awaitAvailable,
        runOnce,
        drain: (maxEffects = Number.MAX_SAFE_INTEGER) =>
          Effect.gen(function* () {
            let completed = 0;
            while (completed < maxEffects && (yield* runOnce)) {
              completed += 1;
            }
            return completed;
          }),
      });
    }),
  );

export const layer = layerWithOptions();

export const daemonLayer: Layer.Layer<never, never, OrchestrationEffectWorkerV2> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const worker = yield* OrchestrationEffectWorkerV2;
      yield* Effect.forever(
        worker.runOnce.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Orchestration effect worker failed", cause).pipe(Effect.as(false)),
          ),
          Effect.flatMap((worked) =>
            worked
              ? Effect.yieldNow
              : Effect.raceFirst(worker.awaitWork, Effect.sleep(Duration.millis(50))),
          ),
        ),
      ).pipe(Effect.forkScoped);
    }),
  );
