import type * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/**
 * The testing project allows 5 Kafka clusters (and 5 Connect clusters) per
 * region and one cluster create request per minute per region. Every test
 * that creates a cluster holds one of these slots for as long as its cluster
 * exists, so the suite never exceeds the regional cluster quota; the
 * providers retry the per-minute `TooManyRequests` throttle. A test's timeout
 * includes the time it waits for a slot, so these tests use long timeouts.
 */
const slots = Semaphore.makeUnsafe(4);

/** Run a cluster-creating Managed Kafka test body while holding one slot. */
export const withKafkaClusterSlot = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => slots.withPermits(1)(self);

/**
 * Take a slot for a shared stack whose cluster outlives one test body
 * (`beforeAll` deploy → `afterAll` destroy). Pair with
 * {@link releaseKafkaClusterSlot} at the end of `afterAll`.
 */
export const takeKafkaClusterSlot: Effect.Effect<number> = slots.take(1);

/** Release a slot taken with {@link takeKafkaClusterSlot}. */
export const releaseKafkaClusterSlot: Effect.Effect<number> = slots.release(1);
