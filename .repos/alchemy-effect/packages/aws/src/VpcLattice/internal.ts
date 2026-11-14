import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Retry an operation while it fails with a VPC Lattice `ConflictException` —
 * raised while a resource still has in-flight associations being torn down.
 * Bounded so a genuinely stuck resource fails fast rather than hanging the
 * engine.
 *
 * The explicit `Effect.Effect<A, E, R>` return annotation is load-bearing:
 * inlining `Effect.retry` in provider lifecycle code lets `Retry.Return`'s
 * conditional type survive into declaration emit and widen the provider layer
 * to `unknown`, breaking every downstream consumer of `AWS.providers()`.
 */
export const retryOnConflict = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(effect, {
    while: (e) => e._tag === "ConflictException",
    schedule: Schedule.max([Schedule.spaced("3 seconds"), Schedule.recurs(10)]),
  });

/**
 * Re-run an observation effect until the observed resource is no longer in a
 * transitional `*_IN_PROGRESS` state (VPC Lattice services and associations
 * spend a while `CREATE_IN_PROGRESS` and reject updates/deletes until active).
 * Bounded; explicit return annotation for the declaration-emit reason above.
 */
export const waitUntilStable = <
  A extends { status?: string },
  E extends { readonly _tag: string },
  R,
>(
  observe: Effect.Effect<A | undefined, E, R>,
): Effect.Effect<A | undefined, E, R> =>
  Effect.repeat(observe, {
    schedule: Schedule.max([Schedule.spaced("3 seconds"), Schedule.recurs(20)]),
    until: (s) => s === undefined || !(s.status ?? "").endsWith("IN_PROGRESS"),
  });

/**
 * Re-run an observation until the resource is observably absent. Delete APIs
 * commonly return before VPC Lattice removes the resource; a merely stable
 * `ACTIVE` response is not deletion success. Bounded to about 60 seconds.
 */
export const waitUntilAbsent = <A, E extends { readonly _tag: string }, R>(
  observe: Effect.Effect<A | undefined, E, R>,
): Effect.Effect<A | undefined, E, R> =>
  Effect.repeat(observe, {
    schedule: Schedule.max([Schedule.spaced("2 seconds"), Schedule.recurs(30)]),
    until: (resource) => resource === undefined,
  });
