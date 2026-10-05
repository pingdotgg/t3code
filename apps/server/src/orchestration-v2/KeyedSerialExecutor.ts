import * as KeyedLock from "@t3tools/shared/KeyedLock";
import type * as Effect from "effect/Effect";

export interface KeyedSerialExecutor<Key> {
  readonly withLock: <A, E, R>(key: Key, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/**
 * Serializes work that targets the same domain identity without coupling
 * unrelated identities to a process-wide mutex.
 */
export const makeKeyedSerialExecutor = <Key>(): Effect.Effect<KeyedSerialExecutor<Key>> =>
  KeyedLock.make<Key>();
