import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";

interface ThreadCacheState {
  generation: number;
  evicted: boolean;
  retainers: number;
  operations: number;
  readonly lock: Semaphore.Semaphore;
}

type EnvironmentThreadCacheStates = Map<ThreadId, ThreadCacheState>;
type CacheStates = Map<EnvironmentId, EnvironmentThreadCacheStates>;

const cacheStates = new WeakMap<EnvironmentCacheStore["Service"], CacheStates>();

function existingThreadCacheState(
  cache: EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ThreadCacheState | undefined {
  return cacheStates.get(cache)?.get(environmentId)?.get(threadId);
}

function threadCacheState(
  cache: EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ThreadCacheState {
  let environmentEntries = cacheStates.get(cache);
  if (environmentEntries === undefined) {
    environmentEntries = new Map();
    cacheStates.set(cache, environmentEntries);
  }

  let threadEntries = environmentEntries.get(environmentId);
  if (threadEntries === undefined) {
    threadEntries = new Map();
    environmentEntries.set(environmentId, threadEntries);
  }

  const existing = threadEntries.get(threadId);
  if (existing !== undefined) {
    return existing;
  }

  const created: ThreadCacheState = {
    generation: 0,
    evicted: false,
    retainers: 0,
    operations: 0,
    lock: Semaphore.makeUnsafe(1),
  };
  threadEntries.set(threadId, created);
  return created;
}

function pruneThreadCacheState(
  cache: EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  threadId: ThreadId,
  state: ThreadCacheState,
): void {
  if (state.retainers > 0 || state.operations > 0) return;

  const environmentEntries = cacheStates.get(cache);
  const threadEntries = environmentEntries?.get(environmentId);
  if (threadEntries?.get(threadId) !== state) return;

  threadEntries.delete(threadId);
  if (threadEntries.size === 0) {
    environmentEntries?.delete(environmentId);
  }
  if (environmentEntries?.size === 0) {
    cacheStates.delete(cache);
  }
}

function withThreadCacheState<A, E, R>(
  cache: EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  threadId: ThreadId,
  use: (state: ThreadCacheState) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const state = threadCacheState(cache, environmentId, threadId);
      state.operations += 1;
      return state;
    }),
    use,
    (state) =>
      Effect.sync(() => {
        state.operations -= 1;
        pruneThreadCacheState(cache, environmentId, threadId, state);
      }),
  );
}

export const retainCachedThread = Effect.fn("EnvironmentThreadCache.retain")(function* (
  cache: EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  threadId: ThreadId,
) {
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const state = threadCacheState(cache, environmentId, threadId);
      state.retainers += 1;
      return state;
    }),
    (state) =>
      Effect.sync(() => {
        state.retainers -= 1;
        pruneThreadCacheState(cache, environmentId, threadId, state);
      }),
  );
});

export function cachedThreadGeneration(
  cache: EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  threadId: ThreadId,
): number {
  return existingThreadCacheState(cache, environmentId, threadId)?.generation ?? 0;
}

export const persistCachedThread = Effect.fn("EnvironmentThreadCache.persist")(function* (
  cache: EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  snapshot: Parameters<EnvironmentCacheStore["Service"]["saveThread"]>[1],
  generation: number,
) {
  const threadId = snapshot.thread.id;
  yield* withThreadCacheState(cache, environmentId, threadId, (state) =>
    // Keep persistence under the same permit as eviction. Otherwise an older
    // write can pass its generation check and finish after cache removal.
    state.lock.withPermit(
      Effect.gen(function* () {
        if (state.evicted || state.generation !== generation) {
          return;
        }
        yield* cache.saveThread(environmentId, snapshot).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not persist the thread cache.").pipe(
              Effect.annotateLogs({
                environmentId,
                threadId,
                ...safeErrorLogAttributes(error),
              }),
            ),
          ),
        );
      }),
    ),
  );
});

export const evictCachedThread = Effect.fn("EnvironmentThreadCache.evict")(function* (
  cache: EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  threadId: ThreadId,
) {
  return yield* withThreadCacheState(cache, environmentId, threadId, (state) =>
    state.lock.withPermit(
      Effect.gen(function* () {
        state.generation += 1;
        state.evicted = true;
        return yield* cache.removeThread(environmentId, threadId).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning("Could not evict cached thread detail.").pipe(
              Effect.annotateLogs({
                environmentId,
                threadId,
                ...safeErrorLogAttributes(error),
              }),
              Effect.as(false),
            ),
          ),
        );
      }),
    ),
  );
});

export const reviveCachedThread = Effect.fn("EnvironmentThreadCache.revive")(function* (
  cache: EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  threadId: ThreadId,
) {
  yield* withThreadCacheState(cache, environmentId, threadId, (state) =>
    state.lock.withPermit(
      Effect.sync(() => {
        if (state.evicted) {
          // Invalidate writes that captured the eviction generation while the
          // tombstone was active before making the cache writable again.
          state.generation += 1;
          state.evicted = false;
        }
      }),
    ),
  );
});
