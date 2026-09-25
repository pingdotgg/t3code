import * as railway from "@distilled.cloud/railway";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

/** Known throttling responses and transport failures safe for read-only callers to retry. */
export const isRailwayTransient = (error: unknown): boolean =>
  railway.isErrorTag(error, [
    "RailwayRateLimited",
    "RailwayOperationInProgress",
  ]) ||
  (error instanceof railway.GraphQLTransportError &&
    (error.status === 429 ||
      error.status === 502 ||
      error.status === 503 ||
      error.status === 504));

/** Space bulk read retries without exceeding the factory retry window. */
export const conservativeSpacing = Schedule.spaced("5 seconds");

const projectAndEnvironmentCreateGate = Semaphore.makeUnsafe(1);

/**
 * Railway rejects project/environment creation within its 30-second creation
 * window. Serialize these calls and retry a typed rejection once after 31s.
 * Other mutation failures propagate so an ambiguous create is never replayed.
 */
export const waitOutCreateRateLimit = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Semaphore.withPermits(
    projectAndEnvironmentCreateGate,
    1,
  )(
    effect.pipe(
      Effect.retry({
        while: (error) => railway.isErrorTag(error, "RailwayRateLimited"),
        times: 1,
        schedule: Schedule.spaced("31 seconds"),
      }),
    ),
  );

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
