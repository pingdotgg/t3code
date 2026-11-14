import { CommandId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  increment,
  metricAttributes,
  orchestrationEffectClaimsTotal,
  orchestrationEffectQueueWait,
} from "../observability/Metrics.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { continueRestartedRun } from "./RestartContinuation.ts";

export class OrchestrationEffectExecutionError extends Schema.TaggedError<OrchestrationEffectExecutionError>()(
  "OrchestrationEffectExecutionError",
  {
    effectId: Schema.String,
    effectType: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * Do not apply this to `provider-turn.restart`: that compound effect also runs
 * detach and start. Swallowing a start failure that happens to mention
 * "is not active" would drop the outbox item without ever starting the
 * replacement turn.
 */
export function isNonRetryableProviderTurnControlFailure(effectType: string, errorText: string): boolean {
  if (effectType !== "provider-turn.interrupt") {
    return false;
  }
  return (
    /is not active/i.test(errorText) ||
    /hard teardown is already in progress/i.test(errorText) ||
    /treating as already interrupted/i.test(errorText) ||
    /treating as already stopped/i.test(errorText)
  );
}

export interface OrchestrationEffectExecutorV2Shape {
  readonly execute: (
    effect: EffectOutbox.OrchestrationEffectV2,
    options?: { readonly willRetry: boolean },
  ) => Effect.Effect<void, OrchestrationEffectExecutionError>;
}

export class OrchestrationEffectExecutorV2 extends Context.Service<
  OrchestrationEffectExecutorV2,
  OrchestrationEffectExecutorV2Shape
>()("t3/orchestration-v2/EffectWorker/OrchestrationEffectExecutorV2") {}

const DELEGATED_TASKS_STOP_TIMEOUT = Duration.seconds(30);

const boundExecution =
  (effect: EffectOutbox.OrchestrationEffectV2) =>
  (execution: Effect.Effect<void, OrchestrationEffectExecutionError>) =>
    effect.request.type === "delegated-tasks.stop"
      ? execution.pipe(
          Effect.timeoutOrElse({
            duration: DELEGATED_TASKS_STOP_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new OrchestrationEffectExecutionError({
                  effectId: effect.id,
                  effectType: effect.request.type,
                  cause: `Timed out after ${Duration.format(DELEGATED_TASKS_STOP_TIMEOUT)}.`,
                }),
              ),
          }),
        )
      : execution;

class OrchestrationEffectWorkerError extends Schema.TaggedError<OrchestrationEffectWorkerError>()(
  "OrchestrationEffectWorkerError",
  {
    operation: Schema.String,
    effectId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isOrchestrationEffectWorkerError = Schema.is(OrchestrationEffectWorkerError);

export interface OrchestrationEffectWorkerV2Shape {
  readonly awaitWork: Effect.Effect<void>;
  readonly runOnce: Effect.Effect<boolean, OrchestrationEffectWorkerError>;
  readonly runRecoveryOnce: Effect.Effect<boolean, OrchestrationEffectWorkerError>;
  readonly nextClaimableAt: Effect.Effect<
    Option.Option<DateTime.Utc>,
    OrchestrationEffectWorkerError
  >;
  readonly drain: (maxEffects?: number) => Effect.Effect<number, OrchestrationEffectWorkerError>;
}

export class OrchestrationEffectWorkerV2 extends Context.Service<
  OrchestrationEffectWorkerV2,
  OrchestrationEffectWorkerV2Shape
>()("t3/orchestration-v2/EffectWorker/OrchestrationEffectWorkerV2") {}

export interface OrchestrationEffectWorkerOptions {
  readonly workerId?: string;
  readonly maxAttempts?: number;
}

export const layerWithOptions = (
  options: OrchestrationEffectWorkerOptions = {},
): Layer.Layer<
  OrchestrationEffectWorkerV2,
  never,
  EffectOutbox.EffectOutboxV2 | OrchestrationEffectExecutorV2
> =>
  Layer.effect(
    OrchestrationEffectWorkerV2,
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const executor = yield* OrchestrationEffectExecutorV2;
      const workerId = options.workerId ?? `orchestration-v2:${process.pid}`;
      const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
      const wasCancelled = (effectId: string) =>
        outbox.get(effectId).pipe(
          Effect.map(
            Option.match({
              onNone: () => false,
              onSome: (effect) => effect.status === "cancelled",
            }),
          ),
        );
      const requeueClaim = (
        effect: EffectOutbox.OrchestrationEffectV2,
        cause: Cause.Cause<unknown>,
      ) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : outbox
              .retry({
                effectId: effect.id,
                workerId,
                error: `Worker failed before settling the claimed effect: ${Cause.pretty(cause)}`,
                delayMs: 0,
              })
              .pipe(
                Effect.flatMap((requeued) =>
                  requeued
                    ? Effect.logWarning("Requeued effect after unexpected worker failure", {
                        effectId: effect.id,
                        effectType: effect.request.type,
                      })
                    : Effect.logWarning("Could not requeue effect after worker lost its lease", {
                        effectId: effect.id,
                        effectType: effect.request.type,
                      }),
                ),
                Effect.catchCause((requeueCause) =>
                  Effect.logError("Failed to requeue effect after unexpected worker failure", {
                    effectId: effect.id,
                    effectType: effect.request.type,
                    error: Cause.pretty(requeueCause),
                  }),
                ),
              );
      const terminalizeClaim = (
        effect: EffectOutbox.OrchestrationEffectV2,
        cause: Cause.Cause<unknown>,
      ) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void;
        return outbox
          .fail({
            effectId: effect.id,
            workerId,
            error: `Worker failed to settle a process-bound effect after execution started: ${Cause.pretty(cause)}`,
          })
          .pipe(
            Effect.flatMap((failed) =>
              failed
                ? Effect.logError("Terminalized process-bound effect after settlement failure", {
                    effectId: effect.id,
                    effectType: effect.request.type,
                  })
                : Effect.logWarning(
                    "Could not terminalize process-bound effect after worker lost its lease",
                    {
                      effectId: effect.id,
                      effectType: effect.request.type,
                    },
                  ),
            ),
            Effect.catchCause((failCause) =>
              Effect.logError(
                "Failed to terminalize process-bound effect after settlement failure",
                {
                  effectId: effect.id,
                  effectType: effect.request.type,
                  error: Cause.pretty(failCause),
                },
              ),
            ),
          );
      };
      const recoverPostSuccessSettlement = (
        effect: EffectOutbox.OrchestrationEffectV2,
        cause: Cause.Cause<unknown>,
      ) =>
        EffectOutbox.REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS.some(
          (effectType) => effectType === effect.request.type,
        )
          ? requeueClaim(effect, cause)
          : terminalizeClaim(effect, cause);

      // The worker probes for work repeatedly, including when the outbox is empty.
      const runOnce = Effect.fnUntraced(
        function* (excludeRestartContinuations = false) {
          const claimExit = yield* Effect.exit(
            outbox.claimNext({ workerId, excludeRestartContinuations }),
          );
          yield* increment(orchestrationEffectClaimsTotal, {
            result: Exit.isFailure(claimExit)
              ? "error"
              : Option.isNone(claimExit.value)
                ? "empty"
                : "claimed",
          });
          if (Exit.isFailure(claimExit)) return yield* Effect.failCause(claimExit.cause);
          const claimed = claimExit.value;
          if (Option.isNone(claimed)) {
            return false;
          }
          const effect = claimed.value;
          // Arm cancellation before rereading durable state to close the read-to-registration race.
          const cancellation = outbox
            .awaitCancellation(effect.id)
            .pipe(Effect.as("cancelled" as const));
          const cancelledBeforeExecution = yield* Effect.gen(function* () {
            const claimedAt = DateTime.toEpochMillis(yield* DateTime.now);
            const eligibleAt = Math.max(
              DateTime.toEpochMillis(DateTime.makeUnsafe(effect.createdAt)),
              DateTime.toEpochMillis(DateTime.makeUnsafe(effect.availableAt)),
            );
            yield* Metric.update(
              Metric.withAttributes(
                orchestrationEffectQueueWait,
                metricAttributes({ effect_type: effect.request.type }),
              ),
              Duration.millis(Math.max(0, claimedAt - eligibleAt)),
            );
            // Recheck durable cancellation after registering the Deferred; cancellation may have committed after claim.
            if (yield* wasCancelled(effect.id)) {
              yield* outbox.clearCancellation(effect.id);
              return true;
            }
            return false;
          }).pipe(Effect.onError((cause) => requeueClaim(effect, cause)));
          if (cancelledBeforeExecution) return true;

          const execution = executor
            .execute(effect, { willRetry: effect.attemptCount < maxAttempts })
            .pipe(boundExecution(effect), Effect.as("executed" as const));
          const exit = yield* Effect.exit(Effect.raceFirst(execution, cancellation)).pipe(
            Effect.ensuring(outbox.clearCancellation(effect.id)),
          );
          if (Exit.isSuccess(exit) && exit.value === "cancelled") {
            return true;
          }
          if (Exit.isSuccess(exit)) {
            return yield* Effect.gen(function* () {
              const completed = yield* outbox.succeed({ effectId: effect.id, workerId });
              if (!completed) {
                if (yield* wasCancelled(effect.id)) return true;
                return yield* new OrchestrationEffectWorkerError({
                  operation: "complete",
                  effectId: effect.id,
                  cause: "The worker no longer owns the effect lease.",
                });
              }
              return true;
            }).pipe(Effect.onError((cause) => recoverPostSuccessSettlement(effect, cause)));
          }

          const error = Cause.pretty(exit.cause);
          const nonRetryable = isNonRetryableProviderTurnControlFailure(effect.request.type, error);
          yield* Effect.logWarning("Orchestration effect execution failed", {
            effectId: effect.id,
            effectType: effect.request.type,
            attemptCount: effect.attemptCount,
            nonRetryable,
            error,
          });
          const updated = nonRetryable
            ? yield* outbox
                .succeed({ effectId: effect.id, workerId })
                .pipe(Effect.onError((cause) => terminalizeClaim(effect, cause)))
            : effect.attemptCount >= maxAttempts
              ? yield* outbox
                  .fail({ effectId: effect.id, workerId, error })
                  .pipe(Effect.onError((cause) => terminalizeClaim(effect, cause)))
              : yield* outbox
                  .retry({
                    effectId: effect.id,
                    workerId,
                    error,
                    delayMs: Math.min(30_000, 100 * 2 ** Math.max(0, effect.attemptCount - 1)),
                  })
                  .pipe(Effect.onError((cause) => requeueClaim(effect, cause)));
          if (!updated) {
            if (yield* wasCancelled(effect.id)) return true;
            return yield* new OrchestrationEffectWorkerError({
              operation: "reschedule",
              effectId: effect.id,
              cause: "The worker no longer owns the effect lease.",
            });
          }
          return true;
        },
        (effect, _excludeRestartContinuations?: boolean) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isOrchestrationEffectWorkerError(cause)
                ? cause
                : new OrchestrationEffectWorkerError({ operation: "run", cause }),
            ),
          ),
      );

      return OrchestrationEffectWorkerV2.of({
        awaitWork: outbox.awaitAvailable,
        runOnce: runOnce(),
        runRecoveryOnce: runOnce(true),
        nextClaimableAt: outbox.nextClaimableAt.pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationEffectWorkerError({
                operation: "next-claimable",
                cause,
              }),
          ),
        ),
        drain: Effect.fn("EffectWorker.drain")(function* (maxEffects = Number.MAX_SAFE_INTEGER) {
          let completed = 0;
          while (completed < maxEffects && (yield* runOnce())) {
            completed += 1;
          }
          return completed;
        }),
      });
    }),
  );

export const layer = layerWithOptions();

export interface OrchestrationEffectDaemonOptions {
  readonly concurrency?: number;
  readonly livenessPollIntervalMs?: number;
}

const DEFAULT_EFFECT_WORKER_CONCURRENCY = 4;
const DEFAULT_EFFECT_WORKER_LIVENESS_POLL_INTERVAL_MS = 30_000;

export const runDaemonWithOptions = (options: OrchestrationEffectDaemonOptions = {}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const worker = yield* OrchestrationEffectWorkerV2;
      const requestedConcurrency = options.concurrency ?? DEFAULT_EFFECT_WORKER_CONCURRENCY;
      const concurrency = Number.isFinite(requestedConcurrency)
        ? Math.max(1, Math.floor(requestedConcurrency))
        : DEFAULT_EFFECT_WORKER_CONCURRENCY;
      const requestedLivenessPollIntervalMs =
        options.livenessPollIntervalMs ?? DEFAULT_EFFECT_WORKER_LIVENESS_POLL_INTERVAL_MS;
      const livenessPollIntervalMs = Number.isFinite(requestedLivenessPollIntervalMs)
        ? Math.max(1, Math.floor(requestedLivenessPollIntervalMs))
        : DEFAULT_EFFECT_WORKER_LIVENESS_POLL_INTERVAL_MS;
      // Notifications wake promptly; availableAt persists retry timing, and liveness polling recovers missed wakeups.
      const runWorker = Effect.gen(function* () {
        while (true) {
          const outcome = yield* worker.runOnce.pipe(
            Effect.map((worked) => (worked ? ("worked" as const) : ("idle" as const))),
            Effect.catchCause((cause) =>
              Effect.logWarning("Orchestration effect worker failed", cause).pipe(
                Effect.as("failed" as const),
              ),
            ),
          );
          if (outcome === "worked") {
            yield* Effect.yieldNow;
            continue;
          }
          if (outcome === "failed") {
            // Failed claims can leave overdue rows; cool off instead of rescheduling at the one-millisecond floor.
            yield* Effect.sleep(Duration.millis(Math.min(1_000, livenessPollIntervalMs)));
            continue;
          }

          const nextClaimableAt = yield* worker.nextClaimableAt.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                "Failed to read the next orchestration effect deadline",
                cause,
              ).pipe(Effect.as(Option.none<DateTime.Utc>())),
            ),
          );
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          const sleepMs = Option.match(nextClaimableAt, {
            onNone: () => livenessPollIntervalMs,
            onSome: (availableAt) => {
              const untilAvailable = DateTime.toEpochMillis(availableAt) - now;
              return Math.min(livenessPollIntervalMs, untilAvailable > 0 ? untilAvailable : 25);
            },
          });
          yield* Effect.raceFirst(
            worker.awaitWork.pipe(Effect.as("notified" as const)),
            Effect.sleep(Duration.millis(sleepMs)).pipe(Effect.as("scheduled" as const)),
          );
        }
      });

      return yield* Effect.all(
        Array.from({ length: concurrency }, () => runWorker),
        {
          concurrency: "unbounded",
          discard: true,
        },
      );
    }),
  );

export const runDaemon = runDaemonWithOptions();
export * from "./EffectWorkerParts.ts";
