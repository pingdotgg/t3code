import * as railway from "@distilled.cloud/railway";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

/**
 * Railway API errors that are safe to retry: throttles plus gateway
 * disconnects (`ServiceUnavailable` "upstream connect error", 502, 504).
 */
export const isRailwayTransient = (e: { _tag: string }): boolean =>
  e._tag === "RailwayRateLimited" ||
  e._tag === "TooManyRequests" ||
  e._tag === "ServiceUnavailable" ||
  e._tag === "BadGateway" ||
  e._tag === "GatewayTimeout";

const createRateLimitWait = Duration.seconds(31);

/** Extra 0..max so concurrent waiters don't share a wake-up. */
const jitterUpTo = (max: Duration.Duration) =>
  Duration.millis(Math.random() * Duration.toMillis(max));

/**
 * 30s plus 0–30s jitter. Railway's public API is ~10k requests/hour;
 * concurrent suite retries have to stay sparse.
 */
export const conservativeSpacing = Schedule.spaced("30 seconds").pipe(
  Schedule.addDelay(() => Effect.sync(() => jitterUpTo(Duration.seconds(30)))),
);

/**
 * One in-flight project/environment create per process. Railway meters
 * those at 1 per 30s per user; concurrent waiters otherwise stampede
 * the cap and distilled's inner Retry-After loop (8 × ~31s).
 */
const projectAndEnvironmentCreateGate = Semaphore.makeUnsafe(1);

const retryCreateRateLimit = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.catch((error) =>
      error instanceof railway.RailwayRateLimited
        ? Effect.sleep(
            Duration.sum(
              error.retryAfter ?? createRateLimitWait,
              jitterUpTo(Duration.seconds(30)),
            ),
          ).pipe(Effect.andThen(retryCreateRateLimit(effect)))
        : Effect.fail(error),
    ),
  );

/**
 * Railway meters project and environment creates at 1 per 30s per user.
 * Distilled tags those as `RailwayRateLimited`. Sleep the hinted delay
 * (or 31s) plus 0–30s jitter and retry until the cap opens. Unbounded.
 * The gate is held across the sleep so the next waiter does not fire
 * another create into a closed window.
 */
export const waitOutCreateRateLimit = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Semaphore.withPermits(
    projectAndEnvironmentCreateGate,
    1,
  )(retryCreateRateLimit(effect));

/**
 * One in-flight environment-config mutation per environment. Railway's
 * own IaC apply is a single `environmentPatchCommit` of the whole desired
 * state. Alchemy splits that across Group / Bucket / ServiceDomain, and
 * `serviceDomainCreate` races those patches — the API answers
 * `Failed to create service domain, please try again`.
 */
const environmentConfigGates = new Map<string, Semaphore.Semaphore>();

export const withEnvironmentConfigLock = <A, E, R>(
  environmentId: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  let gate = environmentConfigGates.get(environmentId);
  if (gate === undefined) {
    gate = Semaphore.makeUnsafe(1);
    environmentConfigGates.set(environmentId, gate);
  }
  return Semaphore.withPermits(gate, 1)(effect);
};
