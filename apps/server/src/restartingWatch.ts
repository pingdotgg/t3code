import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";

// A watcher that keeps failing retries every 30 seconds at most.
const restartSchedule = Schedule.exponential("500 millis").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
);

/**
 * Keeps a file watcher running for the life of the calling fiber. One watch
 * error or a closed watch stream would otherwise stop reloads until the server
 * restarts, so the watcher restarts with capped backoff. Each restart runs
 * `revalidate` first, because changes made while the watcher was down were
 * missed.
 */
export const keepWatching = <E, R1, R2>(input: {
  readonly label: string;
  readonly watch: Effect.Effect<void, E, R1>;
  readonly revalidate: Effect.Effect<void, never, R2>;
}) =>
  Effect.gen(function* () {
    const restarted = yield* Ref.make(false);
    const runOnce = Ref.getAndSet(restarted, true).pipe(
      Effect.flatMap((isRestart) => (isRestart ? input.revalidate : Effect.void)),
      Effect.andThen(input.watch),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) => Effect.logWarning(`${input.label} watcher failed; restarting`, { cause }),
      ),
    );
    return yield* Effect.repeat(runOnce, restartSchedule);
  });
