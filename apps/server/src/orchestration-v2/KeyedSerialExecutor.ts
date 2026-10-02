import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

interface LockEntry {
  readonly semaphore: Semaphore.Semaphore;
  readonly users: number;
}

export interface KeyedSerialExecutor<Key> {
  readonly withLock: <A, E, R>(key: Key, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/**
 * Serializes work that targets the same domain identity without coupling
 * unrelated identities to a process-wide mutex.
 */
export const makeKeyedSerialExecutor = <Key>(): Effect.Effect<KeyedSerialExecutor<Key>> =>
  Effect.gen(function* () {
    const locks = yield* Ref.make(new Map<Key, LockEntry>());

    const acquireLock = (key: Key) =>
      Effect.gen(function* () {
        const candidate = yield* Semaphore.make(1);
        return yield* Ref.modify(locks, (current) => {
          const existing = current.get(key);
          const semaphore = existing?.semaphore ?? candidate;
          const next = new Map(current);
          next.set(key, { semaphore, users: (existing?.users ?? 0) + 1 });
          return [semaphore, next] as const;
        });
      });

    const releaseLock = (key: Key) =>
      Ref.update(locks, (current) => {
        const existing = current.get(key);
        if (existing === undefined) return current;
        const next = new Map(current);
        if (existing.users === 1) {
          next.delete(key);
        } else {
          next.set(key, { ...existing, users: existing.users - 1 });
        }
        return next;
      });

    return {
      withLock: (key, effect) =>
        Effect.acquireUseRelease(
          acquireLock(key),
          (semaphore) => semaphore.withPermit(effect),
          () => releaseLock(key),
        ),
    } satisfies KeyedSerialExecutor<Key>;
  });
