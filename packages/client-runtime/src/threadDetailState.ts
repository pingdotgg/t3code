import { pipe } from "effect/Function";
import * as Order from "effect/Order";
import * as Arr from "effect/Array";
import type {
  OrchestrationThread,
  OrchestrationThreadStreamItem,
  ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import {
  DEFAULT_THREAD_DETAIL_LIMITS,
  applyThreadDetailEvent,
  type ThreadDetailRetentionLimits,
} from "./threadDetailReducer";
import type { WsRpcClient } from "./wsRpcClient";

export interface ThreadDetailState {
  readonly data: OrchestrationThread | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly isDeleted: boolean;
}

export interface ThreadDetailTarget {
  readonly environmentId: string | null;
  readonly threadId: string | null;
}

export type ThreadDetailClient = Pick<WsRpcClient["orchestration"], "subscribeThread">;

export interface ThreadDetailRetentionPolicy {
  readonly idleTtlMs: number;
  readonly maxRetainedEntries: number;
  readonly shouldKeepWarm?: (
    target: { readonly environmentId: string; readonly threadId: string },
    state: ThreadDetailState,
  ) => boolean;
}

interface ThreadDetailEntry {
  readonly target: {
    readonly environmentId: string;
    readonly threadId: string;
  };
  watcherCount: number;
  retainCount: number;
  teardown: () => void;
  lastAccessedAt: number;
  evictionTimeoutId: ReturnType<typeof setTimeout> | null;
}

const NOOP: () => void = () => undefined;

function clearEntryEviction(entry: ThreadDetailEntry): void {
  if (entry.evictionTimeoutId !== null) {
    clearTimeout(entry.evictionTimeoutId);
    entry.evictionTimeoutId = null;
  }
}

export const EMPTY_THREAD_DETAIL_STATE = Object.freeze<ThreadDetailState>({
  data: null,
  error: null,
  isPending: false,
  isDeleted: false,
});

const INITIAL_THREAD_DETAIL_STATE = Object.freeze<ThreadDetailState>({
  data: null,
  error: null,
  isPending: true,
  isDeleted: false,
});

const knownThreadDetailKeys = new Set<string>();

export const threadDetailStateAtom = Atom.family((key: string) => {
  knownThreadDetailKeys.add(key);
  return Atom.make(INITIAL_THREAD_DETAIL_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`thread-detail:${key}`),
  );
});

export const EMPTY_THREAD_DETAIL_ATOM = Atom.make(EMPTY_THREAD_DETAIL_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("thread-detail:null"),
);

export function getThreadDetailTargetKey(target: ThreadDetailTarget): string | null {
  if (target.environmentId === null || target.threadId === null) {
    return null;
  }

  return `${target.environmentId}:${target.threadId}`;
}

export interface ThreadDetailManagerConfig {
  readonly getRegistry: () => AtomRegistry.AtomRegistry;
  readonly getClient: (environmentId: string) => ThreadDetailClient | null;
  readonly getClientIdentity?: (environmentId: string) => string | null;
  readonly subscribeClientChanges?: (listener: () => void) => () => void;
  readonly limits?: ThreadDetailRetentionLimits;
  readonly retention?: ThreadDetailRetentionPolicy;
}

export function createThreadDetailManager(config: ThreadDetailManagerConfig) {
  const entries = new Map<string, ThreadDetailEntry>();

  function getSnapshot(target: ThreadDetailTarget): ThreadDetailState {
    const targetKey = getThreadDetailTargetKey(target);
    if (targetKey === null) {
      return EMPTY_THREAD_DETAIL_STATE;
    }

    return config.getRegistry().get(threadDetailStateAtom(targetKey));
  }

  function setState(targetKey: string, nextState: ThreadDetailState): void {
    config.getRegistry().set(threadDetailStateAtom(targetKey), nextState);
    reconcileRetention(targetKey);
  }

  function markPending(targetKey: string): void {
    const current = config.getRegistry().get(threadDetailStateAtom(targetKey));
    setState(targetKey, {
      ...current,
      error: null,
      isPending: true,
    });
  }

  function setData(targetKey: string, thread: OrchestrationThread): void {
    setState(targetKey, {
      data: thread,
      error: null,
      isPending: false,
      isDeleted: false,
    });
  }

  function setDeleted(targetKey: string): void {
    setState(targetKey, {
      data: null,
      error: null,
      isPending: false,
      isDeleted: true,
    });
  }

  function shouldKeepWarm(entry: ThreadDetailEntry): boolean {
    return config.retention?.shouldKeepWarm?.(entry.target, getSnapshot(entry.target)) ?? false;
  }

  function disposeEntry(targetKey: string): void {
    const entry = entries.get(targetKey);
    if (!entry) {
      return;
    }

    clearEntryEviction(entry);
    entry.teardown();
    entries.delete(targetKey);
  }

  function evictIdleEntriesToCapacity(): void {
    const retention = config.retention;
    if (!retention || entries.size <= retention.maxRetainedEntries) {
      return;
    }

    const idleEntries = pipe(
      Arr.fromIterable(entries),
      Arr.filter(
        ([, entry]) =>
          entry.watcherCount === 0 && entry.retainCount === 0 && !shouldKeepWarm(entry),
      ),
      Arr.sortWith(([, e]) => e.lastAccessedAt, Order.Number),
    );

    for (const [targetKey] of idleEntries) {
      if (entries.size <= retention.maxRetainedEntries) {
        return;
      }
      disposeEntry(targetKey);
    }
  }

  function scheduleEviction(targetKey: string, entry: ThreadDetailEntry): void {
    const retention = config.retention;
    clearEntryEviction(entry);

    if (!retention) {
      disposeEntry(targetKey);
      return;
    }

    if (retention.idleTtlMs <= 0) {
      disposeEntry(targetKey);
      return;
    }

    entry.evictionTimeoutId = setTimeout(() => {
      const current = entries.get(targetKey);
      if (!current) {
        return;
      }

      current.evictionTimeoutId = null;
      if (current.watcherCount > 0 || current.retainCount > 0 || shouldKeepWarm(current)) {
        return;
      }

      disposeEntry(targetKey);
    }, retention.idleTtlMs);
  }

  function reconcileRetention(targetKey: string): void {
    const entry = entries.get(targetKey);
    if (!entry) {
      return;
    }

    clearEntryEviction(entry);
    if (entry.watcherCount > 0 || entry.retainCount > 0 || shouldKeepWarm(entry)) {
      return;
    }

    scheduleEviction(targetKey, entry);
    evictIdleEntriesToCapacity();
  }

  function applyStreamItem(
    targetKey: string,
    item: OrchestrationThreadStreamItem,
    threadId: ThreadIdType,
  ): void {
    if (item.kind === "snapshot") {
      setData(targetKey, item.snapshot.thread);
      return;
    }

    const current = getSnapshot({
      environmentId: entries.get(targetKey)?.target.environmentId ?? null,
      threadId,
    }).data;

    if (current === null) {
      if (item.event.type === "thread.deleted") {
        setDeleted(targetKey);
      }
      return;
    }

    const result = applyThreadDetailEvent(
      current,
      item.event,
      config.limits ?? DEFAULT_THREAD_DETAIL_LIMITS,
    );

    if (result.kind === "updated") {
      setData(targetKey, result.thread);
      return;
    }

    if (result.kind === "deleted") {
      setDeleted(targetKey);
    }
  }

  function subscribeStream(
    targetKey: string,
    target: { readonly environmentId: string; readonly threadId: string },
    client: ThreadDetailClient,
  ): () => void {
    markPending(targetKey);
    return client.subscribeThread(
      { threadId: ThreadId.make(target.threadId) },
      (item) => applyStreamItem(targetKey, item, ThreadId.make(target.threadId)),
      {
        onResubscribe: () => markPending(targetKey),
      },
    );
  }

  function createDynamicSubscription(
    targetKey: string,
    target: { readonly environmentId: string; readonly threadId: string },
  ): () => void {
    let currentIdentity: string | null = null;
    let currentUnsub = NOOP;

    const sync = () => {
      const client = config.getClient(target.environmentId);
      const identity = client
        ? (config.getClientIdentity?.(target.environmentId) ?? target.environmentId)
        : null;

      if (!client || identity === null) {
        if (currentIdentity !== null) {
          currentUnsub();
          currentUnsub = NOOP;
          currentIdentity = null;
        }
        markPending(targetKey);
        return;
      }

      if (currentIdentity === identity) {
        return;
      }

      currentUnsub();
      currentIdentity = identity;
      currentUnsub = subscribeStream(targetKey, target, client);
    };

    const unsubChanges = config.subscribeClientChanges!(sync);
    sync();

    return () => {
      unsubChanges();
      currentUnsub();
    };
  }

  function acquire(
    target: ThreadDetailTarget,
    kind: "watcher" | "retain",
    client?: ThreadDetailClient,
  ): () => void {
    const targetKey = getThreadDetailTargetKey(target);
    if (targetKey === null || target.environmentId === null || target.threadId === null) {
      return NOOP;
    }

    const existing = entries.get(targetKey);
    if (existing) {
      clearEntryEviction(existing);
      existing.lastAccessedAt = Date.now();
      if (kind === "watcher") {
        existing.watcherCount += 1;
      } else {
        existing.retainCount += 1;
      }
      return () => release(targetKey, kind);
    }

    let teardown: () => void;
    const resolvedTarget = {
      environmentId: target.environmentId,
      threadId: target.threadId,
    };

    if (client) {
      teardown = subscribeStream(targetKey, resolvedTarget, client);
    } else if (config.subscribeClientChanges) {
      teardown = createDynamicSubscription(targetKey, resolvedTarget);
    } else {
      const resolved = config.getClient(target.environmentId);
      if (!resolved) {
        return NOOP;
      }
      teardown = subscribeStream(targetKey, resolvedTarget, resolved);
    }

    entries.set(targetKey, {
      target: resolvedTarget,
      watcherCount: kind === "watcher" ? 1 : 0,
      retainCount: kind === "retain" ? 1 : 0,
      teardown,
      lastAccessedAt: Date.now(),
      evictionTimeoutId: null,
    });
    evictIdleEntriesToCapacity();
    return () => release(targetKey, kind);
  }

  function release(targetKey: string, kind: "watcher" | "retain"): void {
    const entry = entries.get(targetKey);
    if (!entry) {
      return;
    }

    if (kind === "watcher") {
      entry.watcherCount = Math.max(0, entry.watcherCount - 1);
    } else {
      entry.retainCount = Math.max(0, entry.retainCount - 1);
    }
    entry.lastAccessedAt = Date.now();
    reconcileRetention(targetKey);
  }

  function watch(target: ThreadDetailTarget, client?: ThreadDetailClient): () => void {
    return acquire(target, "watcher", client);
  }

  function retain(target: ThreadDetailTarget, client?: ThreadDetailClient): () => void {
    return acquire(target, "retain", client);
  }

  function invalidate(target?: ThreadDetailTarget): void {
    if (target) {
      const targetKey = getThreadDetailTargetKey(target);
      if (targetKey !== null) {
        disposeEntry(targetKey);
        config.getRegistry().set(threadDetailStateAtom(targetKey), EMPTY_THREAD_DETAIL_STATE);
      }
      return;
    }

    for (const targetKey of entries.keys()) {
      disposeEntry(targetKey);
    }
    for (const key of knownThreadDetailKeys) {
      config.getRegistry().set(threadDetailStateAtom(key), EMPTY_THREAD_DETAIL_STATE);
    }
  }

  function reset(): void {
    invalidate();
  }

  return {
    watch,
    retain,
    getSnapshot,
    invalidate,
    reset,
  };
}
