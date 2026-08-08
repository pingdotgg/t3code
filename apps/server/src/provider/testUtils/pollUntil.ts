import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

const describeValue = (value: unknown) => {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) {
      return String(value);
    }
    return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
  } catch {
    return String(value);
  }
};

export interface PollUntilOptions<A, E, R> {
  /** Effect run on each attempt; its latest result is checked with `until`. */
  readonly poll: Effect.Effect<A, E, R>;
  /** Predicate on the polled value that ends the wait. */
  readonly until: (value: A) => boolean;
  /** Human-readable description of what is being waited for, used in the timeout error. */
  readonly description: string;
  /** Wall-clock budget for the whole wait. Defaults to 10 seconds. */
  readonly timeout?: Duration.Input;
  /** Wall-clock pause between attempts. Defaults to 25 millis. */
  readonly interval?: Duration.Input;
}

/**
 * Repeatedly runs `poll` until `until` matches, sleeping on the live clock
 * between attempts.
 *
 * Tests running under `@effect/vitest`'s `it.effect` / `it.layer` are on the
 * `TestClock`, where `Effect.sleep` only advances via `TestClock.adjust` and
 * `Effect.yieldNow` yields no wall-clock time at all. Polling loops built from
 * those primitives give out-of-process work — mock agent child processes,
 * real `ChildProcessSpawner` probes, libuv I/O callbacks — essentially zero
 * real time to complete, which makes them flaky on loaded CI hosts. Sleeping
 * via `TestClock.withLive` lets the event loop and child processes make
 * progress while the rest of the test stays on the virtual clock.
 *
 * Dies with a descriptive error (including the last polled value) when the
 * budget is exhausted, so a timeout fails loudly instead of letting a later
 * assertion fail on stale data.
 */
export const pollUntil = <A, E, R>(options: PollUntilOptions<A, E, R>) =>
  Effect.gen(function* () {
    const timeoutMillis = Duration.toMillis(options.timeout ?? "10 seconds");
    const interval = options.interval ?? "25 millis";
    const startedAt = yield* TestClock.withLive(Clock.currentTimeMillis);
    for (;;) {
      const value = yield* options.poll;
      if (options.until(value)) {
        return value;
      }
      const now = yield* TestClock.withLive(Clock.currentTimeMillis);
      if (now - startedAt >= timeoutMillis) {
        return yield* Effect.die(
          new Error(
            `Timed out after ${timeoutMillis}ms waiting for ${options.description}. ` +
              `Last polled value: ${describeValue(value)}`,
          ),
        );
      }
      yield* TestClock.withLive(Effect.sleep(interval));
    }
  });
