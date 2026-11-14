import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Shared Amazon Macie provider scaffolding. NOT exported from `index.ts`.
 */

/**
 * Macie enablement is eventually consistent — resource creation can briefly
 * reject with the synthetic `MacieNotEnabled` tag right after the session is
 * enabled. Retry on a bounded schedule (< 30s total). The explicit
 * `Effect.Effect<A, E, R>` return annotation keeps `Retry.Return`'s
 * conditional type out of declaration emit, which would otherwise widen the
 * provider layer's `R` to `unknown` and poison every consumer of
 * `AWS.providers()`.
 */
export const retryThroughEnablement = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "MacieNotEnabled",
    schedule: Schedule.max([Schedule.spaced("3 seconds"), Schedule.recurs(8)]),
  });
