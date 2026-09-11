import * as railway from "@distilled.cloud/railway";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";

const isThrottled = (error: unknown): boolean =>
  error instanceof railway.TooManyRequests ||
  error instanceof railway.RailwayRateLimited;

/**
 * Railway-wide retry policy for every SDK call made by the providers.
 *
 * Railway's GraphQL gateway rate-limits aggressively under concurrency
 * (many resources reconciling at once) and usually omits `Retry-After`,
 * so the SDK's default policy — 8 attempts, ~20s of patience — gives up
 * while the throttling window is still open and a bare `TooManyRequests`
 * escapes the provider. Keep the default transient classification (which
 * includes throttling, server, network, and locked errors) but:
 *
 * - throttling errors poll SLOWLY (25s floor) so the rate window refills
 *   instead of being re-drained by the retries themselves, with ~30
 *   attempts (~12 minutes of patience for a suite-wide window);
 * - every other transient error keeps fast exponential backoff capped at
 *   15s per delay.
 */
export const factory: railway.Retry.Factory = (lastError) => {
  const base = railway.Retry.makeDefault(lastError);
  return {
    while: base.while,
    schedule: Schedule.max([
      Schedule.exponential(500, 2).pipe(
        railway.Retry.capped(Duration.seconds(15)),
        Schedule.modifyDelay(({ duration }) =>
          Effect.gen(function* () {
            const error = yield* Ref.get(lastError);
            return isThrottled(error) &&
              Duration.isLessThan(duration, Duration.seconds(25))
              ? Duration.seconds(25)
              : duration;
          }),
        ),
        railway.Retry.jittered,
      ),
      Schedule.recurs(30),
    ]),
  };
};

/** Provide the Railway retry policy to every operation below. */
export const RailwayRetryPolicy: Layer.Layer<railway.Retry.Retry> =
  Layer.succeed(railway.Retry.Retry, factory);
