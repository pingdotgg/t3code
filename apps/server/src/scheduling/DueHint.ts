import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";

// Backstop for a write path that forgets to invalidate.
const DUE_HINT_MAX_AGE_MS = 10 * 60 * 1_000;

/**
 * Remembers when a poller next has work so idle scheduler ticks skip SQL.
 * `invalidate` after every write that can move work earlier; a tick records
 * only if no write happened since it read `version`.
 */
export const make = () => {
  let version = 0;
  let hint: { readonly dueAtMs: number; readonly checkedAtMs: number } | null = null;
  let wake = Deferred.makeUnsafe<void>();
  return {
    invalidate: Effect.sync(() => {
      version++;
      hint = null;
      Deferred.doneUnsafe(wake, Effect.void);
    }),
    awaitNext: Effect.gen(function* () {
      const signal = wake;
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const delayMs =
        hint === null
          ? 5_000
          : Math.max(
              1,
              Math.min(hint.dueAtMs - nowMs, hint.checkedAtMs + DUE_HINT_MAX_AGE_MS - nowMs),
            );
      yield* Deferred.await(signal).pipe(
        Effect.timeoutOrElse({ duration: delayMs, orElse: () => Effect.void }),
        Effect.ensuring(
          Effect.sync(() => {
            if (wake === signal) wake = Deferred.makeUnsafe<void>();
          }),
        ),
      );
    }),
    version: Effect.sync(() => version),
    isIdle: (nowMs: number) =>
      Effect.sync(
        () =>
          hint !== null && hint.dueAtMs > nowMs && nowMs - hint.checkedAtMs < DUE_HINT_MAX_AGE_MS,
      ),
    record: (readVersion: number, dueAtMs: number, nowMs: number) =>
      Effect.sync(() => {
        if (readVersion === version) hint = { dueAtMs, checkedAtMs: nowMs };
      }),
  };
};
