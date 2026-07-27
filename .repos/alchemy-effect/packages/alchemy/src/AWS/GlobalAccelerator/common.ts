import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

// Global Accelerator is a global service, but its control-plane API only
// exists in us-west-2 ("you must specify the US West (Oregon) Region to
// create, update, or otherwise work with accelerators"). Pin every call so
// the resources work regardless of the ambient deployment region.
export const GA_REGION = "us-west-2" as const;

// NOTE: the Region service's value is an Effect<RegionName>, not a string.
export const withGaRegion = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(AwsRegion, Effect.succeed(GA_REGION)));

/**
 * Global Accelerator serializes configuration changes per accelerator as
 * "transactions"; a second mutation while one is propagating is rejected with
 * `TransactionInProgressException` (or `ConflictException`). Retry on a
 * bounded schedule (~60s) until the in-flight transaction lands.
 *
 * NOTE: explicit return annotation is load-bearing — an inline `Effect.retry`
 * in provider lifecycle code leaks `Retry.Return` conditionals into
 * declaration emit and widens the provider layer to `unknown` R.
 */
export const retryGaTransaction = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e._tag === "TransactionInProgressException" ||
      e._tag === "ConflictException",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(20)]),
  });

/**
 * Deletion is subject to both GA's serialized transactions and occasional
 * transient internal-service failures. Keep the retry bounded to about one
 * minute so teardown converges without hanging indefinitely.
 */
export const retryGaDeletion = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e._tag === "TransactionInProgressException" ||
      e._tag === "ConflictException" ||
      e._tag === "InternalServiceErrorException",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(20)]),
  });

/**
 * `deleteAccelerator` requires the accelerator to be fully disabled and all
 * listeners removed. Both conditions clear asynchronously after the disabling
 * `updateAccelerator` / dependent deletes return, so retry the delete on a
 * bounded schedule (~3 minutes) until the disable transaction propagates.
 */
export const retryUntilAcceleratorDeletable = <
  A,
  E extends { _tag: string },
  R,
>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e._tag === "AcceleratorNotDisabledException" ||
      e._tag === "AssociatedListenerFoundException" ||
      e._tag === "TransactionInProgressException" ||
      e._tag === "InternalServiceErrorException",
    schedule: Schedule.max([Schedule.fixed("5 seconds"), Schedule.recurs(36)]),
  });

/**
 * `deleteListener` is rejected with `AssociatedEndpointGroupFoundException`
 * while a just-deleted endpoint group is still detaching. Retry briefly.
 */
export const retryUntilListenerDeletable = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e._tag === "AssociatedEndpointGroupFoundException" ||
      e._tag === "TransactionInProgressException" ||
      e._tag === "InternalServiceErrorException",
    schedule: Schedule.max([Schedule.fixed("5 seconds"), Schedule.recurs(24)]),
  });
