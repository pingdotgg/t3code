import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import type * as ProviderRuntimeRecovery from "./orchestration-v2/ProviderRuntimeRecoveryService.ts";
import type * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import type { UpdatePause } from "./updatePause.ts";

const INTERRUPT_SETTLE_TIMEOUT = "30 seconds";
const UPDATE_PAUSE_DEADLINE = "2 minutes";

type PauseState =
  | { readonly _tag: "running" }
  | {
      readonly _tag: "paused";
      readonly pausedRuns: number;
      readonly deadline: Fiber.Fiber<void>;
    }
  | { readonly _tag: "stopping" };

export interface UpdatePauseDependencies {
  readonly closeCommands: Effect.Effect<void>;
  readonly reopenCommands: Effect.Effect<void>;
  readonly stopEffectWorker: Effect.Effect<void>;
  readonly startEffectWorker: Effect.Effect<void>;
  readonly recovery: Pick<
    ProviderRuntimeRecovery.ProviderRuntimeRecoveryService["Service"],
    "prepareForUpdate" | "reconcile"
  >;
  readonly sessions: Pick<
    ProviderSessionManager.ProviderSessionManagerV2Shape,
    "interruptForShutdown" | "resumeEventIngestion" | "shutdown"
  >;
}

/**
 * A pause ends in a restart. When none comes before the deadline, or the updater reports a
 * failure, the server undoes it in place the way a restart would: sessions are released, the
 * cut runs are reconciled, and the worker delivers each stored continuation once.
 */
export const makeUpdatePauseController = Effect.fn("UpdatePause.makeController")(function* (
  deps: UpdatePauseDependencies,
) {
  const state = yield* Ref.make<PauseState>({ _tag: "running" });
  const lock = yield* Semaphore.make(1);
  const scope = yield* Effect.scope;

  const resumeLocked = Effect.gen(function* () {
    if ((yield* Ref.get(state))._tag !== "paused") return;
    yield* Ref.set(state, { _tag: "running" });
    yield* deps.sessions.shutdown;
    yield* deps.sessions.resumeEventIngestion;
    yield* deps.recovery.reconcile("shutdown", { update: "not-installed" }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not reconcile turns paused for an update", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
    yield* deps.reopenCommands;
    yield* deps.startEffectWorker;
    yield* Effect.logInfo("Resumed turns paused for an update that did not install");
  }).pipe(Effect.uninterruptible);
  const resume = lock.withPermits(1)(resumeLocked);

  const pauseRunsForUpdate: UpdatePause["Service"]["pauseRunsForUpdate"] = lock
    .withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (current._tag === "paused") return { pausedRuns: current.pausedRuns };
        if (current._tag === "stopping") return { pausedRuns: 0 };
        yield* deps.closeCommands;
        yield* deps.stopEffectWorker;
        const turns = yield* deps.recovery.prepareForUpdate.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not prepare running turns for an update", {
              cause: Cause.pretty(cause),
            }).pipe(Effect.as([])),
          ),
        );
        yield* Effect.logInfo("Pausing running turns for an update", { turns: turns.length });
        yield* deps.sessions
          .interruptForShutdown(turns)
          .pipe(Effect.timeoutOption(INTERRUPT_SETTLE_TIMEOUT));
        const deadline = yield* Effect.sleep(UPDATE_PAUSE_DEADLINE).pipe(
          Effect.andThen(resume),
          Effect.forkIn(scope),
        );
        yield* Ref.set(state, { _tag: "paused", pausedRuns: turns.length, deadline });
        return { pausedRuns: turns.length };
      }).pipe(Effect.uninterruptible),
    )
    .pipe(Effect.withSpan("server.pauseRunsForUpdate"));

  const resumeRunsAfterUpdate: UpdatePause["Service"]["resumeRunsAfterUpdate"] = Effect.gen(
    function* () {
      const current = yield* Ref.get(state);
      if (current._tag !== "paused") return;
      yield* Fiber.interrupt(current.deadline);
      yield* resume;
    },
  ).pipe(Effect.withSpan("server.resumeRunsAfterUpdate"));

  /** Returns whether the server stops while paused, so shutdown keeps the paused notice. */
  const beginShutdown = lock.withPermits(1)(
    Effect.gen(function* () {
      const previous = yield* Ref.getAndSet(state, { _tag: "stopping" });
      if (previous._tag !== "paused") return false;
      yield* Fiber.interrupt(previous.deadline);
      return true;
    }),
  );

  return { pauseRunsForUpdate, resumeRunsAfterUpdate, beginShutdown };
});
