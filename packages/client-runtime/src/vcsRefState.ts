import type {
  EnvironmentId,
  VcsListRefsInput,
  VcsListRefsResult,
  VcsRef as ContractVcsRef,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry, type AsyncResult } from "effect/unstable/reactivity";

import type { WsRpcClient } from "./wsRpcClient.ts";

export interface VcsRefTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly query?: string | null;
}

export interface VcsRefScope {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
}

export interface VcsRefState {
  readonly data: VcsListRefsResult | null;
  readonly isPending: boolean;
  readonly error: string | null;
}

export type VcsRef = ContractVcsRef;
export type VcsRefClient = Pick<WsRpcClient["vcs"], "listRefs">;

export const EMPTY_VCS_REF_STATE = Object.freeze<VcsRefState>({
  data: null,
  isPending: false,
  error: null,
});

const INITIAL_VCS_REF_STATE = Object.freeze<VcsRefState>({
  data: null,
  isPending: true,
  error: null,
});

const knownVcsRefKeys = new Set<string>();

export const vcsRefStateAtom = Atom.family((key: string) => {
  knownVcsRefKeys.add(key);
  return Atom.make(EMPTY_VCS_REF_STATE).pipe(Atom.keepAlive, Atom.withLabel(`vcs-refs:${key}`));
});

export const EMPTY_VCS_REF_ATOM = Atom.make(EMPTY_VCS_REF_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("vcs-refs:null"),
);

function normalizeQuery(query: string | null | undefined): string {
  return query?.trim() ?? "";
}

export function getVcsRefTargetKey(target: VcsRefTarget): string | null {
  if (target.environmentId === null || target.cwd === null) {
    return null;
  }

  return `${target.environmentId}:${target.cwd}:${normalizeQuery(target.query)}`;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to load refs.";
}

function mergeRefs(
  previous: ReadonlyArray<VcsRef>,
  next: ReadonlyArray<VcsRef>,
): ReadonlyArray<VcsRef> {
  const merged = new Map<string, VcsRef>();
  for (const branch of previous) {
    merged.set(branch.name, branch);
  }
  for (const branch of next) {
    merged.set(branch.name, branch);
  }
  return [...merged.values()];
}

export interface VcsRefManagerConfig {
  readonly getRegistry: () => AtomRegistry.AtomRegistry;
  readonly getClient: (environmentId: EnvironmentId) => VcsRefClient | null;
  readonly subscribeClientChanges?: (listener: () => void) => () => void;
  readonly watchLimit?: number;
  readonly staleTimeMs?: number;
  readonly onBackgroundError?: (error: unknown) => void;
}

interface WatchedEntry {
  refCount: number;
  teardown: () => void;
}

const NOOP: () => void = () => undefined;

export function createVcsRefManager(config: VcsRefManagerConfig) {
  const inFlight = new Map<
    string,
    {
      readonly client: VcsRefClient;
      readonly promise: Promise<VcsListRefsResult | null>;
    }
  >();
  const loadVersions = new Map<string, number>();
  const watched = new Map<string, WatchedEntry>();
  const lastLoadedAt = new Map<string, number>();
  const refreshTargets = new Map<string, VcsRefTarget>();
  const watchLoadOptions =
    config.watchLimit === undefined
      ? undefined
      : { limit: config.watchLimit, preserveLoadedRefs: true };

  const watchedRefreshAtom = Atom.family((targetKey: string) =>
    Atom.make(() =>
      Effect.promise(() => {
        const target = refreshTargets.get(targetKey);
        return target ? load(target, undefined, watchLoadOptions) : Promise.resolve(null);
      }),
    ).pipe(
      Atom.swr({
        staleTime: config.staleTimeMs ?? 0,
        revalidateOnMount: true,
      }),
      Atom.withLabel(`vcs-refs:watched-refresh:${targetKey}`),
    ),
  );

  function getLoadVersion(targetKey: string): number {
    return loadVersions.get(targetKey) ?? 0;
  }

  function bumpLoadVersion(targetKey: string): number {
    const next = getLoadVersion(targetKey) + 1;
    loadVersions.set(targetKey, next);
    return next;
  }

  function getSnapshot(target: VcsRefTarget): VcsRefState {
    const targetKey = getVcsRefTargetKey(target);
    if (targetKey === null) {
      return EMPTY_VCS_REF_STATE;
    }
    return config.getRegistry().get(vcsRefStateAtom(targetKey));
  }

  function setState(targetKey: string, nextState: VcsRefState): void {
    config.getRegistry().set(vcsRefStateAtom(targetKey), nextState);
  }

  function markPending(targetKey: string): void {
    const current = config.getRegistry().get(vcsRefStateAtom(targetKey));
    setState(
      targetKey,
      current.data === null ? INITIAL_VCS_REF_STATE : { ...current, isPending: true, error: null },
    );
  }

  function setData(targetKey: string, data: VcsListRefsResult): void {
    lastLoadedAt.set(targetKey, Effect.runSync(Clock.currentTimeMillis));
    setState(targetKey, {
      data,
      isPending: false,
      error: null,
    });
  }

  function setError(targetKey: string, error: unknown): void {
    const current = config.getRegistry().get(vcsRefStateAtom(targetKey));
    setState(targetKey, {
      data: current.data,
      isPending: false,
      error: toErrorMessage(error),
    });
  }

  async function load(
    target: VcsRefTarget,
    client?: VcsRefClient,
    options?: {
      readonly cursor?: number;
      readonly limit?: number;
      readonly append?: boolean;
      readonly preserveLoadedRefs?: boolean;
    },
  ): Promise<VcsListRefsResult | null> {
    const targetKey = getVcsRefTargetKey(target);
    if (targetKey === null || target.environmentId === null || target.cwd === null) {
      return null;
    }
    refreshTargets.set(targetKey, target);

    const resolved = client ?? config.getClient(target.environmentId);
    if (!resolved) {
      return getSnapshot(target).data;
    }

    const inFlightKey = `${targetKey}:${options?.cursor ?? "start"}:${options?.append ? "append" : "replace"}`;
    const existing = inFlight.get(inFlightKey);
    if (existing && existing.client === resolved) {
      return existing.promise;
    }

    markPending(targetKey);
    const loadVersion = bumpLoadVersion(targetKey);

    const current = getSnapshot(target).data;
    const request: VcsListRefsInput = {
      cwd: target.cwd,
      ...(normalizeQuery(target.query).length > 0 ? { query: normalizeQuery(target.query) } : {}),
      ...(options?.cursor !== undefined ? { cursor: options.cursor } : {}),
      ...(options?.limit !== undefined ? { limit: options.limit } : {}),
    };

    const promise = resolved.listRefs(request).then(
      (result) => {
        const nextData =
          options?.append && current
            ? {
                ...result,
                refs: mergeRefs(current.refs, result.refs),
              }
            : options?.preserveLoadedRefs && current && current.refs.length > result.refs.length
              ? {
                  ...result,
                  refs: mergeRefs(result.refs, current.refs),
                  nextCursor: current.nextCursor,
                  totalCount: Math.max(result.totalCount, current.totalCount),
                }
              : result;
        if (getLoadVersion(targetKey) === loadVersion) {
          setData(targetKey, nextData);
        }
        return nextData;
      },
      (error) => {
        if (getLoadVersion(targetKey) === loadVersion) {
          setError(targetKey, error);
        }
        throw error;
      },
    );

    inFlight.set(inFlightKey, { client: resolved, promise });
    try {
      return await promise;
    } finally {
      if (inFlight.get(inFlightKey)?.promise === promise) {
        inFlight.delete(inFlightKey);
      }
    }
  }

  function loadInBackground(
    target: VcsRefTarget,
    client: VcsRefClient,
    options?: {
      readonly cursor?: number;
      readonly limit?: number;
      readonly append?: boolean;
      readonly preserveLoadedRefs?: boolean;
    },
  ): void {
    void load(target, client, options).catch((error: unknown) => {
      config.onBackgroundError?.(error);
    });
  }

  async function loadNext(
    target: VcsRefTarget,
    client?: VcsRefClient,
    options?: { readonly limit?: number },
  ): Promise<VcsListRefsResult | null> {
    const current = getSnapshot(target).data;
    if (!current?.nextCursor && current?.nextCursor !== 0) {
      return current ?? null;
    }

    return load(target, client, {
      cursor: current.nextCursor,
      append: true,
      ...(options?.limit !== undefined ? { limit: options.limit } : {}),
    });
  }

  function refreshWatchedTarget(targetKey: string, target: VcsRefTarget, client?: VcsRefClient) {
    refreshTargets.set(targetKey, target);

    if (client || config.staleTimeMs === undefined) {
      const resolved =
        client ?? (target.environmentId ? config.getClient(target.environmentId) : null);
      if (resolved) {
        loadInBackground(target, resolved, watchLoadOptions);
      }
      return;
    }

    const lastLoaded = lastLoadedAt.get(targetKey);
    if (
      lastLoaded !== undefined &&
      Effect.runSync(Clock.currentTimeMillis) - lastLoaded < config.staleTimeMs
    ) {
      return;
    }

    const result = config
      .getRegistry()
      .get(watchedRefreshAtom(targetKey)) as AsyncResult.AsyncResult<
      VcsListRefsResult | null,
      unknown
    >;
    if (result._tag === "Failure") {
      config.onBackgroundError?.(result.cause);
    }
  }

  function watch(target: VcsRefTarget, client?: VcsRefClient): () => void {
    const targetKey = getVcsRefTargetKey(target);
    if (targetKey === null || target.environmentId === null || target.cwd === null) {
      return NOOP;
    }

    const existing = watched.get(targetKey);
    if (existing) {
      existing.refCount += 1;
      return () => unwatch(targetKey);
    }

    let teardown: () => void;

    if (client) {
      refreshWatchedTarget(targetKey, target, client);
      teardown = NOOP;
    } else if (config.subscribeClientChanges) {
      let currentClient: VcsRefClient | null = null;
      const sync = () => {
        const resolved = config.getClient(target.environmentId!);
        if (!resolved) {
          currentClient = null;
          return;
        }
        if (currentClient === resolved) {
          return;
        }

        const hadClient = currentClient !== null;
        currentClient = resolved;
        refreshWatchedTarget(targetKey, target, hadClient ? resolved : undefined);
      };

      const unsubscribe = config.subscribeClientChanges(sync);
      sync();
      teardown = unsubscribe;
    } else {
      const resolved = config.getClient(target.environmentId);
      if (!resolved) {
        return NOOP;
      }
      refreshWatchedTarget(targetKey, target);
      teardown = NOOP;
    }

    watched.set(targetKey, { refCount: 1, teardown });
    return () => unwatch(targetKey);
  }

  function unwatch(targetKey: string): void {
    const entry = watched.get(targetKey);
    if (!entry) {
      return;
    }

    entry.refCount -= 1;
    if (entry.refCount > 0) {
      return;
    }

    entry.teardown();
    watched.delete(targetKey);
  }

  function invalidate(target?: VcsRefTarget): void {
    if (target) {
      const targetKey = getVcsRefTargetKey(target);
      if (targetKey !== null) {
        bumpLoadVersion(targetKey);
        setState(targetKey, EMPTY_VCS_REF_STATE);
        for (const key of inFlight.keys()) {
          if (key.startsWith(`${targetKey}:`)) {
            inFlight.delete(key);
          }
        }
      }
      return;
    }

    for (const key of knownVcsRefKeys) {
      bumpLoadVersion(key);
      setState(key, EMPTY_VCS_REF_STATE);
    }
    inFlight.clear();
  }

  function invalidateScope(scope: VcsRefScope): void {
    if (scope.environmentId === null || scope.cwd === null) {
      return;
    }

    const keyPrefix = `${scope.environmentId}:${scope.cwd}:`;
    for (const key of knownVcsRefKeys) {
      if (key.startsWith(keyPrefix)) {
        bumpLoadVersion(key);
        setState(key, EMPTY_VCS_REF_STATE);
      }
    }

    for (const key of inFlight.keys()) {
      if (key.startsWith(keyPrefix)) {
        inFlight.delete(key);
      }
    }
  }

  function reset(): void {
    for (const entry of watched.values()) {
      entry.teardown();
    }
    watched.clear();
    inFlight.clear();
    loadVersions.clear();
    lastLoadedAt.clear();
    refreshTargets.clear();
    invalidate();
  }

  return {
    getSnapshot,
    watch,
    load,
    loadNext,
    invalidate,
    invalidateScope,
    reset,
  };
}
