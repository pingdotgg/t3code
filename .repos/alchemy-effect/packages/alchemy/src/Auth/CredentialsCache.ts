import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

/**
 * Refresh expiring credentials this long before they actually expire so that
 * in-flight requests never race the expiry deadline.
 */
export const CREDENTIAL_REFRESH_WINDOW = Duration.minutes(5);

/** Compute how long credentials may remain cached. */
export const credentialTimeToLive = (
  expiresAt: number | undefined,
  resolvedAt: number,
): Duration.Duration => {
  if (expiresAt === undefined) return Duration.infinity;
  return Duration.millis(
    Math.max(
      0,
      expiresAt - resolvedAt - Duration.toMillis(CREDENTIAL_REFRESH_WINDOW),
    ),
  );
};

/**
 * Build a single-entry Effect cache whose TTL is derived from each resolved
 * credential's expiry. Concurrent cache misses share one resolution.
 */
export const cacheUntilExpiry = <A, E>(
  resolve: Effect.Effect<A, E>,
  expiresAt: (credentials: A) => number | undefined,
) =>
  Effect.gen(function* () {
    const cache = yield* Cache.makeWith(
      (_: void) =>
        Effect.gen(function* () {
          const resolvedAt = yield* Clock.currentTimeMillis;
          const credentials = yield* resolve;
          return { credentials, resolvedAt };
        }),
      {
        capacity: 1,
        timeToLive: (exit) =>
          Exit.isSuccess(exit)
            ? credentialTimeToLive(
                expiresAt(exit.value.credentials),
                exit.value.resolvedAt,
              )
            : Duration.zero,
      },
    );
    return Cache.get(cache, undefined).pipe(
      Effect.map(({ credentials }) => credentials),
    );
  });
