import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

/**
 * Time this process's shutdown in the run log: a Debug record when SIGINT or
 * SIGTERM arrives, and one when `effect` has finished (finalizers included),
 * with the time since the signal. Silent when the process ends on its own.
 */
export const logShutdown =
  (name: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const clock = yield* Clock.Clock;
      let signalled: { readonly signal: string; readonly at: number } | undefined;
      const onSignal = (signal: NodeJS.Signals) => {
        if (signalled !== undefined) return;
        signalled = { signal, at: clock.currentTimeMillisUnsafe() };
        Effect.runForkWith(context)(Effect.logDebug(`shutdown: ${name} received ${signal}`));
      };
      // Ahead of the runtime's own handler, which interrupts this fiber and
      // can run its whole teardown synchronously before later listeners.
      process.prependListener("SIGINT", onSignal);
      process.prependListener("SIGTERM", onSignal);
      return yield* effect.pipe(
        Effect.onExit(() =>
          Effect.flatMap(Clock.currentTimeMillis, (now) => {
            process.off("SIGINT", onSignal);
            process.off("SIGTERM", onSignal);
            return signalled === undefined
              ? Effect.void
              : Effect.logDebug(
                  `shutdown: ${name} finished ${now - signalled.at}ms after ${signalled.signal}`,
                );
          }),
        ),
      );
    });

/** Run `effect` and log how long it took, as a step of a shutdown. */
export const timedShutdownStep =
  (step: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(Clock.currentTimeMillis, (start) =>
      effect.pipe(
        Effect.onExit(() =>
          Effect.flatMap(Clock.currentTimeMillis, (end) =>
            Effect.logDebug(`shutdown: ${step} in ${end - start}ms`),
          ),
        ),
      ),
    );
