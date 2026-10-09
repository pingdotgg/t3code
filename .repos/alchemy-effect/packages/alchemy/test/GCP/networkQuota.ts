import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/**
 * The testing project allows 5 VPC networks, and `default` holds one.
 * Tests that create their own network take a slot for their whole body
 * (deploy through destroy), so a full `pnpm test test/GCP` run never
 * exceeds the quota. One slot stays free for stacks that outlive a run
 * (Cloud Run keeps Direct VPC egress subnets reserved for 1–2 hours after
 * a service is deleted).
 *
 * Tests that only need *a* network should use the project's `default`
 * network instead of creating one — the GCP counterpart of AWS tests
 * reusing the default VPC.
 */
const slots = Semaphore.makeUnsafe(3);

/** Run a network-creating test body while holding one VPC quota slot. */
export const withNetworkSlot = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => slots.withPermits(1)(self);

/** Like {@link withNetworkSlot}, for a test body that creates `count` networks. */
export const withNetworkSlots =
  (count: number) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    slots.withPermits(count)(self);

/** The project's pre-existing `default` network (auto-mode). */
export const DEFAULT_NETWORK = "default";

/** Self link of the project's `default` network. */
export const defaultNetworkSelfLink = (project: string) =>
  `https://www.googleapis.com/compute/v1/projects/${project}/global/networks/${DEFAULT_NETWORK}`;
