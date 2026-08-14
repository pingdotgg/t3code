import type { ScopedThreadRef } from "@t3tools/contracts";

import {
  clearBackgroundConnectionRetainedThread as clearPersistedRetainedThread,
  loadBackgroundConnectionRetainedThread as loadPersistedRetainedThread,
  saveBackgroundConnectionRetainedThread as savePersistedRetainedThread,
} from "../../persistence/imperative";

interface RetainedThreadSnapshot {
  readonly loaded: boolean;
  readonly thread: ScopedThreadRef | null;
}

const EMPTY_SNAPSHOT: RetainedThreadSnapshot = Object.freeze({
  loaded: false,
  thread: null,
});

let snapshot = EMPTY_SNAPSHOT;
let revision = 0;
let loading: Promise<ScopedThreadRef | null> | null = null;
let persistenceQueue: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

function threadRefsEqual(left: ScopedThreadRef | null, right: ScopedThreadRef | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.environmentId === right.environmentId &&
      left.threadId === right.threadId)
  );
}

function publish(next: RetainedThreadSnapshot): void {
  if (snapshot.loaded === next.loaded && threadRefsEqual(snapshot.thread, next.thread)) {
    return;
  }
  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

export function getBackgroundConnectionRetainedThreadSnapshot(): RetainedThreadSnapshot {
  return snapshot;
}

export function subscribeBackgroundConnectionRetainedThread(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function ensureBackgroundConnectionRetainedThreadLoaded(): Promise<ScopedThreadRef | null> {
  if (snapshot.loaded) {
    return Promise.resolve(snapshot.thread);
  }
  if (loading !== null) {
    return loading;
  }

  const loadRevision = revision;
  const persistedLoad = persistenceQueue.then(
    loadPersistedRetainedThread,
    loadPersistedRetainedThread,
  );
  // Loading can also remove malformed persisted data. Treat it as part of the
  // same storage sequence so that cleanup cannot race and delete a newer save.
  persistenceQueue = persistedLoad.then(
    () => undefined,
    () => undefined,
  );
  loading = persistedLoad
    .then((thread) => {
      if (revision === loadRevision) {
        publish({ loaded: true, thread });
      }
      return snapshot.thread;
    })
    .catch((error) => {
      console.warn("[background-connection] failed to load the retained thread", error);
      // Keep a cold snapshot retryable. A transient secure-storage/runtime
      // failure must not suppress the persisted retained thread for the rest
      // of this JS process.
      return snapshot.thread;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

function enqueuePersistence(operation: () => Promise<void>): Promise<void> {
  const queued = persistenceQueue.then(operation, operation);
  persistenceQueue = queued.catch(() => undefined);
  return queued;
}

export async function saveBackgroundConnectionRetainedThread(
  thread: ScopedThreadRef,
): Promise<void> {
  revision += 1;
  publish({ loaded: true, thread });
  try {
    await enqueuePersistence(() => savePersistedRetainedThread(thread));
  } catch (error) {
    console.warn("[background-connection] failed to persist the retained thread", error);
  }
}

export async function clearBackgroundConnectionRetainedThread(): Promise<void> {
  revision += 1;
  publish({ loaded: true, thread: null });
  try {
    await enqueuePersistence(clearPersistedRetainedThread);
  } catch (error) {
    console.warn("[background-connection] failed to clear the retained thread", error);
  }
}

export function clearBackgroundConnectionRetainedThreadInMemory(): void {
  revision += 1;
  publish({ loaded: true, thread: null });
}
