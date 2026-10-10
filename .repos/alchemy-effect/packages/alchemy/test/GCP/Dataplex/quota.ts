import type * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/**
 * Dataplex throttles control-plane writes per project per minute. With the
 * whole suite running in one process, more than a few concurrent Dataplex
 * lifecycles exhaust the quota and time out, so every Dataplex test holds
 * one of these slots for its whole body. A test's timeout includes the time
 * it waits for a slot, so Dataplex tests use generous (15 min) timeouts.
 */
const slots = Semaphore.makeUnsafe(4);

/** Run a Dataplex test body while holding one API-quota slot. */
export const withDataplexSlot = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => slots.withPermits(1)(self);
