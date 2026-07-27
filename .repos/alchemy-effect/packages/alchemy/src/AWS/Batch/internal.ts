import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Bounded 5-second poll (~3 minutes total) until `until` is satisfied.
 *
 * Explicitly annotated so the `Effect.repeat` conditional return type never
 * survives into declaration emit (which would widen the provider layers of
 * every `AWS.providers()` consumer — see processes/AWS/PATTERNS.md §7).
 */
export const pollBatch = <A, E, R>(
  self: Effect.Effect<A, E, R>,
  until: (a: A) => boolean,
): Effect.Effect<A, E, R> =>
  Effect.repeat(self, {
    schedule: Schedule.spaced("5 seconds"),
    until,
    times: 36,
  });

/**
 * Bounded retry (5s spacing, 10 tries) while the typed predicate holds.
 * Same explicit-annotation rationale as {@link pollBatch}.
 */
export const retryBatch = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
  while_: (e: E) => boolean,
  times = 10,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: while_,
    schedule: Schedule.max([
      Schedule.spaced("5 seconds"),
      Schedule.recurs(times),
    ]),
  });
