import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

export interface KeyedLock<Key> {
  /** Runs `effect` once no other holder of `key` is running, in arrival order. */
  readonly withLock: <A, E, R>(key: Key, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** The keys someone holds or waits on right now. */
  readonly activeKeys: Effect.Effect<ReadonlyArray<Key>>;
}

interface LockEntry {
  readonly semaphore: Semaphore.Semaphore;
  users: number;
}

/**
 * Mutual exclusion per key. A key's lock exists only while someone holds or
 * waits on it, so locks for keys that come and go never accumulate. Not
 * reentrant: taking a key while already holding it deadlocks.
 *
 * Keys compare like `Map` keys (by value for strings and numbers). The lock is
 * not tied to a scope, so it keeps working for as long as anyone references it.
 */
export const make = <Key>(): Effect.Effect<KeyedLock<Key>> =>
  Effect.sync(() => {
    const locks = new Map<Key, LockEntry>();

    const acquire = (key: Key) =>
      Effect.sync(() => {
        let entry = locks.get(key);
        if (entry === undefined) {
          entry = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
          locks.set(key, entry);
        }
        entry.users += 1;
        return entry;
      });

    const release = (key: Key, entry: LockEntry) =>
      Effect.sync(() => {
        entry.users -= 1;
        if (entry.users === 0) locks.delete(key);
      });

    return {
      withLock: (key, effect) =>
        Effect.acquireUseRelease(
          acquire(key),
          (entry) => entry.semaphore.withPermit(effect),
          (entry) => release(key, entry),
        ),
      activeKeys: Effect.sync(() => Array.from(locks.keys())),
    };
  });
