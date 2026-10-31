import {
  type IssueTrackerError,
  NotConnected,
  RateLimited,
  Unauthorized,
  Unavailable,
} from "@t3tools/issue-tracker-core/errors";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

const UNAVAILABLE_BASE_MS = 5_000;
const UNAVAILABLE_MAX_MS = 5 * 60_000;
/** Hold off once the remaining request budget is this low, until the window resets. */
const LOW_BUDGET_THRESHOLD = 5;

/**
 * Remembers what Linear last told this server so calls can be refused locally instead of hammering
 * it: a rejected key, an exhausted rate limit window, or exponentially backed-off outages.
 */
export interface LinearBackoff {
  /** Runs `effect` unless a known condition makes the call pointless; records the outcome. */
  readonly guard: <A>(
    apiKey: string,
    effect: Effect.Effect<A, IssueTrackerError>,
  ) => Effect.Effect<A, IssueTrackerError>;
  readonly noteRateLimit: (observation: {
    readonly remaining: number | null;
    readonly resetsAtMs: number | null;
  }) => Effect.Effect<void>;
  /** The key Linear rejected, if any; replacing the key makes it stale. */
  readonly rejectedKey: Effect.Effect<string | null>;
  readonly rateLimitedUntilMs: Effect.Effect<number | null>;
  /** Forget outage backoff (manual refresh). The rate limit window is Linear's, so it stays. */
  readonly clearOutage: Effect.Effect<void>;
  readonly reset: Effect.Effect<void>;
}

export const makeLinearBackoff = (): LinearBackoff => {
  let rejectedKey: string | null = null;
  let rateLimitedUntil = 0;
  let unavailableUntil = 0;
  let failures = 0;

  const clearOutage = Effect.sync(() => {
    unavailableUntil = 0;
    failures = 0;
  });

  return {
    guard: Effect.fn("LinearBackoff.guard")(function* <A>(
      apiKey: string,
      effect: Effect.Effect<A, IssueTrackerError>,
    ) {
      if (apiKey.length === 0) return yield* new NotConnected();
      if (rejectedKey === apiKey) return yield* new Unauthorized();
      const before = yield* Clock.currentTimeMillis;
      if (before < rateLimitedUntil) {
        return yield* new RateLimited({
          retryAfterSeconds: Math.ceil((rateLimitedUntil - before) / 1000),
        });
      }
      if (before < unavailableUntil) {
        return yield* new Unavailable({ message: "Couldn't reach Linear." });
      }
      return yield* effect.pipe(
        Effect.tap(() => clearOutage),
        Effect.tapError((error) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) =>
              Effect.sync(() => {
                switch (error._tag) {
                  case "IssueTrackerUnauthorized":
                    rejectedKey = apiKey;
                    break;
                  case "IssueTrackerRateLimited":
                    rateLimitedUntil = now + error.retryAfterSeconds * 1000;
                    break;
                  case "IssueTrackerUnavailable":
                    failures += 1;
                    unavailableUntil =
                      now + Math.min(UNAVAILABLE_MAX_MS, UNAVAILABLE_BASE_MS * 2 ** (failures - 1));
                    break;
                  default:
                    break;
                }
              }),
            ),
          ),
        ),
      );
    }),
    noteRateLimit: ({ remaining, resetsAtMs }) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          Effect.sync(() => {
            if (
              remaining !== null &&
              remaining <= LOW_BUDGET_THRESHOLD &&
              resetsAtMs !== null &&
              resetsAtMs > now
            ) {
              rateLimitedUntil = Math.max(rateLimitedUntil, resetsAtMs);
            }
          }),
        ),
      ),
    rejectedKey: Effect.sync(() => rejectedKey),
    rateLimitedUntilMs: Clock.currentTimeMillis.pipe(
      Effect.map((now) => (rateLimitedUntil > now ? rateLimitedUntil : null)),
    ),
    clearOutage,
    reset: Effect.sync(() => {
      rejectedKey = null;
      rateLimitedUntil = 0;
      unavailableUntil = 0;
      failures = 0;
    }),
  };
};
