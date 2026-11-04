import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

const projectAndEnvironmentCreateGate = Semaphore.makeUnsafe(1);

/**
 * Railway rejects project/environment creation within its 30-second creation
 * window. Serialize these calls and retry a typed rejection once after 31s.
 * Other mutation failures propagate so an ambiguous create is never replayed.
 */
export const waitOutCreateRateLimit = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Semaphore.withPermits(
    projectAndEnvironmentCreateGate,
    1,
  )(
    effect.pipe(
      Effect.retry({
        while: (error) => error._tag === "RailwayRateLimited",
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
