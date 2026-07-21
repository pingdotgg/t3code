import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";

interface ThreadCacheState {
  generation: number;
  evicted: boolean;
  readonly lock: Semaphore.Semaphore;
}

const cacheStates = new WeakMap<EnvironmentCacheStore["Service"], Map<string, ThreadCacheState>>();

function threadCacheState(
  cache: EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ThreadCacheState {
  let entries = cacheStates.get(cache);
  if (entries === undefined) {
    entries = new Map();
    cacheStates.set(cache, entries);
  }

  const key = JSON.stringify([environmentId, threadId]);
  const existing = entries.get(key);
  if (existing !== undefined) {
    return existing;
  }

  const created: ThreadCacheState = {
    generation: 0,
    evicted: false,
    lock: Semaphore.makeUnsafe(1),
  };
  entries.set(key, created);
  return created;
}

export function cachedThreadGeneration(
  cache: EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  threadId: ThreadId,
): number {
  return threadCacheState(cache, environmentId, threadId).generation;
}

export const persistCachedThread = Effect.fn("EnvironmentThreadCache.persist")(function* (
  cache: EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  snapshot: Parameters<EnvironmentCacheStore["Service"]["saveThread"]>[1],
  generation: number,
) {
  const threadId = snapshot.thread.id;
  const state = threadCacheState(cache, environmentId, threadId);
  yield* state.lock.withPermit(
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
  );
});

export const evictCachedThread = Effect.fn("EnvironmentThreadCache.evict")(function* (
  cache: EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  threadId: ThreadId,
) {
  const state = threadCacheState(cache, environmentId, threadId);
  yield* state.lock.withPermit(
    Effect.gen(function* () {
      state.generation += 1;
      state.evicted = true;
      yield* cache.removeThread(environmentId, threadId).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not evict cached thread detail.").pipe(
            Effect.annotateLogs({
              environmentId,
              threadId,
              ...safeErrorLogAttributes(error),
            }),
          ),
        ),
      );
    }),
  );
});

export const reviveCachedThread = Effect.fn("EnvironmentThreadCache.revive")(function* (
  cache: EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  threadId: ThreadId,
) {
  const state = threadCacheState(cache, environmentId, threadId);
  yield* state.lock.withPermit(
    Effect.sync(() => {
      state.generation += 1;
      state.evicted = false;
    }),
  );
});
