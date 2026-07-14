import { type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

interface LifecycleLock {
  readonly semaphore: Semaphore.Semaphore;
  readonly users: number;
}

export const makeThreadLifecycleLock = Effect.fn("makeThreadLifecycleLock")(function* () {
  const locksRef = yield* SynchronizedRef.make(new Map<ThreadId, LifecycleLock>());

  const acquire = (threadId: ThreadId) =>
    SynchronizedRef.modifyEffect(locksRef, (current) => {
      const existing = current.get(threadId);
      if (existing) {
        const next = new Map(current);
        next.set(threadId, { semaphore: existing.semaphore, users: existing.users + 1 });
        return Effect.succeed([existing.semaphore, next] as const);
      }
      return Semaphore.make(1).pipe(
        Effect.map((semaphore) => {
          const next = new Map(current);
          next.set(threadId, { semaphore, users: 1 });
          return [semaphore, next] as const;
        }),
      );
    });

  const release = (threadId: ThreadId, semaphore: Semaphore.Semaphore) =>
    SynchronizedRef.update(locksRef, (current) => {
      const lock = current.get(threadId);
      if (!lock || lock.semaphore !== semaphore) {
        return current;
      }
      const next = new Map(current);
      if (lock.users === 1) {
        next.delete(threadId);
      } else {
        next.set(threadId, { semaphore, users: lock.users - 1 });
      }
      return next;
    });

  const withLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      acquire(threadId),
      (semaphore) => semaphore.withPermit(effect),
      (semaphore) => release(threadId, semaphore),
    );

  const activeThreadIds = SynchronizedRef.get(locksRef).pipe(
    Effect.map((locks) => new Set(locks.keys())),
  );

  return {
    withLock,
    activeThreadIds,
  } as const;
});
