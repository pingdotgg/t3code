import type { SourceControlDiscoveryResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

/* --- Types ---------------------------------------------------------- */

export interface SourceControlDiscoveryState {
  readonly data: SourceControlDiscoveryResult | null;
  readonly error: string | null;
  readonly isPending: boolean;
}

export interface SourceControlDiscoveryTarget<TKey extends string = string> {
  readonly key: TKey | null;
}

export interface SourceControlDiscoveryClient {
  readonly discoverSourceControl: () => Promise<SourceControlDiscoveryResult>;
}

interface WatchedEntry {
  refCount: number;
  teardown: () => void;
}

/* --- Constants ------------------------------------------------------ */

export const EMPTY_SOURCE_CONTROL_DISCOVERY_STATE = Object.freeze<SourceControlDiscoveryState>({
  data: null,
  error: null,
  isPending: false,
});

const INITIAL_SOURCE_CONTROL_DISCOVERY_STATE = Object.freeze<SourceControlDiscoveryState>({
  data: null,
  error: null,
  isPending: true,
});

/* --- Atoms ---------------------------------------------------------- */

const knownSourceControlDiscoveryKeys = new Set<string>();

export const sourceControlDiscoveryStateAtom = Atom.family((key: string) => {
  knownSourceControlDiscoveryKeys.add(key);
  return Atom.make(INITIAL_SOURCE_CONTROL_DISCOVERY_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`source-control-discovery:${key}`),
  );
});

export const EMPTY_SOURCE_CONTROL_DISCOVERY_ATOM = Atom.make(
  EMPTY_SOURCE_CONTROL_DISCOVERY_STATE,
).pipe(Atom.keepAlive, Atom.withLabel("source-control-discovery:null"));

/* --- Helpers -------------------------------------------------------- */

export function getSourceControlDiscoveryTargetKey<TKey extends string>(
  target: SourceControlDiscoveryTarget<TKey>,
): TKey | null {
  const key = target.key;
  return key && key.length > 0 ? key : null;
}

/* --- Refresh manager ------------------------------------------------ */

export interface SourceControlDiscoveryManagerConfig<TKey extends string = string> {
  /**
   * Get the atom registry used to read/write source-control discovery snapshots.
   */
  readonly getRegistry: () => AtomRegistry.AtomRegistry;
  /**
   * Resolve the runtime client for a discovery target key.
   *
   * Web currently uses a single `"primary"` target, but keeping this keyed
   * lets mobile or future multi-environment clients provide separate discovery
   * clients without changing the state primitive.
   */
  readonly getClient: (key: TKey) => SourceControlDiscoveryClient | null;
  /**
   * Optional: subscribe to environment/client availability changes.
   *
   * When provided, `watch` refreshes as clients appear or are replaced
   * instead of relying on React hooks to manually kick discovery.
   */
  readonly subscribeClientChanges?: (listener: () => void) => () => void;
  readonly staleTimeMs?: number;
  readonly idleTtlMs?: number;
}

const NOOP: () => void = () => undefined;
const DEFAULT_STALE_TIME_MS = 30_000;
const DEFAULT_IDLE_TTL_MS = 5 * 60_000;

export function createSourceControlDiscoveryManager<TKey extends string = string>(
  config: SourceControlDiscoveryManagerConfig<TKey>,
) {
  const refreshInFlight = new Map<
    string,
    {
      readonly client: SourceControlDiscoveryClient;
      readonly promise: Promise<SourceControlDiscoveryResult | null>;
    }
  >();
  const refreshVersions = new Map<string, number>();
  const watched = new Map<string, WatchedEntry>();
  const refreshTargets = new Map<string, SourceControlDiscoveryTarget<TKey>>();
  const staleTimeMs = config.staleTimeMs ?? DEFAULT_STALE_TIME_MS;
  const idleTtlMs = config.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;

  const watchedRefreshAtom = Atom.family((targetKey: string) =>
    Atom.make(() =>
      Effect.promise(() => {
        const target = refreshTargets.get(targetKey);
        return target ? refresh(target) : Promise.resolve(null);
      }),
    ).pipe(
      Atom.swr({
        staleTime: staleTimeMs,
        revalidateOnMount: true,
      }),
      Atom.setIdleTTL(idleTtlMs),
      Atom.withLabel(`source-control-discovery:watched-refresh:${targetKey}`),
    ),
  );

  function getRefreshVersion(targetKey: string): number {
    return refreshVersions.get(targetKey) ?? 0;
  }

  function bumpRefreshVersion(targetKey: string): void {
    refreshVersions.set(targetKey, getRefreshVersion(targetKey) + 1);
  }

  /* -- Atom helpers -------------------------------------------------- */

  function setState(targetKey: string, nextState: SourceControlDiscoveryState): void {
    config.getRegistry().set(sourceControlDiscoveryStateAtom(targetKey), nextState);
  }

  function markPending(targetKey: string): void {
    const current = config.getRegistry().get(sourceControlDiscoveryStateAtom(targetKey));
    const next: SourceControlDiscoveryState =
      current.data === null
        ? INITIAL_SOURCE_CONTROL_DISCOVERY_STATE
        : {
            data: current.data,
            error: null,
            isPending: true,
          };

    if (
      current.data === next.data &&
      current.error === next.error &&
      current.isPending === next.isPending
    ) {
      return;
    }

    setState(targetKey, next);
  }

  function setData(targetKey: string, data: SourceControlDiscoveryResult): void {
    setState(targetKey, {
      data,
      error: null,
      isPending: false,
    });
  }

  function setError(targetKey: string, error: unknown): void {
    const current = config.getRegistry().get(sourceControlDiscoveryStateAtom(targetKey));
    setState(targetKey, {
      data: current.data,
      error: error instanceof Error ? error.message : "Failed to discover source control tools.",
      isPending: false,
    });
  }

  /* -- Public API ---------------------------------------------------- */

  /**
   * Trigger a one-shot source-control discovery RPC for a target.
   *
   * Calls are deduplicated while a refresh for the same target key is in
   * flight. On failure, the previous successful snapshot is kept in `data`
   * and the error message is stored separately so UI can keep rendering stale
   * discovery results while showing the failure.
   *
   * @param target The logical runtime target to refresh.
   * @param client Optional pre-resolved client, useful in tests.
   */
  function refresh(
    target: SourceControlDiscoveryTarget<TKey>,
    client?: SourceControlDiscoveryClient,
  ): Promise<SourceControlDiscoveryResult | null> {
    const targetKey = getSourceControlDiscoveryTargetKey(target);
    if (targetKey === null) {
      return Promise.resolve(null);
    }
    refreshTargets.set(targetKey, target);

    const resolvedClient = client ?? config.getClient(targetKey);
    if (!resolvedClient) {
      const error = new Error("Source control discovery client is unavailable.");
      setError(targetKey, error);
      return Promise.resolve(getSnapshot(target).data);
    }

    const existing = refreshInFlight.get(targetKey);
    if (existing) {
      if (!client || existing.client === resolvedClient) {
        return existing.promise;
      }

      return existing.promise.then(() => refresh(target, resolvedClient));
    }

    markPending(targetKey);
    const refreshVersion = getRefreshVersion(targetKey);
    const promise = resolvedClient.discoverSourceControl().then(
      (result) => {
        if (getRefreshVersion(targetKey) === refreshVersion) {
          setData(targetKey, result);
        }
        return result;
      },
      (error: unknown) => {
        if (getRefreshVersion(targetKey) === refreshVersion) {
          setError(targetKey, error);
        }
        return getSnapshot(target).data;
      },
    );
    let tracked: Promise<SourceControlDiscoveryResult | null>;
    tracked = promise.finally(() => {
      if (refreshInFlight.get(targetKey)?.promise === tracked) {
        refreshInFlight.delete(targetKey);
      }
    });
    refreshInFlight.set(targetKey, {
      client: resolvedClient,
      promise: tracked,
    });
    return tracked;
  }

  /**
   * Reset discovery state for one target and ignore any currently in-flight
   * refresh for that target. If no target is provided, every known target is
   * invalidated.
   */
  function invalidate(target?: SourceControlDiscoveryTarget<TKey>): void {
    if (!target) {
      reset();
      return;
    }

    const targetKey = getSourceControlDiscoveryTargetKey(target);
    if (targetKey === null) {
      return;
    }

    bumpRefreshVersion(targetKey);
    refreshInFlight.delete(targetKey);
    setState(targetKey, INITIAL_SOURCE_CONTROL_DISCOVERY_STATE);
  }

  /**
   * Read the current atom snapshot for `target`.
   *
   * Invalid targets return the inert empty state rather than creating a new
   * family atom entry.
   */
  function getSnapshot(target: SourceControlDiscoveryTarget<TKey>): SourceControlDiscoveryState {
    const targetKey = getSourceControlDiscoveryTargetKey(target);
    if (targetKey === null) {
      return EMPTY_SOURCE_CONTROL_DISCOVERY_STATE;
    }

    return config.getRegistry().get(sourceControlDiscoveryStateAtom(targetKey));
  }

  /**
   * Keep discovery warm for `target`.
   *
   * Multiple callers sharing a target key are ref-counted. With
   * `subscribeClientChanges`, the manager refreshes whenever a client first
   * appears or is replaced after reconnect.
   */
  function watch(
    target: SourceControlDiscoveryTarget<TKey>,
    client?: SourceControlDiscoveryClient,
  ): () => void {
    const targetKey = getSourceControlDiscoveryTargetKey(target);
    if (targetKey === null) {
      return NOOP;
    }
    refreshTargets.set(targetKey, target);

    const existing = watched.get(targetKey);
    if (existing) {
      existing.refCount += 1;
      return () => unwatch(targetKey);
    }

    let teardown: () => void;

    if (client) {
      void refresh(target, client);
      teardown = NOOP;
    } else if (config.subscribeClientChanges) {
      let currentClient: SourceControlDiscoveryClient | null = null;

      const sync = () => {
        const resolved = config.getClient(targetKey);
        if (!resolved) {
          currentClient = null;
          markPending(targetKey);
          return;
        }

        if (currentClient === resolved) {
          return;
        }

        const isClientReplacement = currentClient !== null;
        currentClient = resolved;
        refreshWatchedTarget(targetKey, target, isClientReplacement ? resolved : undefined);
      };

      const unsubChanges = config.subscribeClientChanges(sync);
      sync();
      teardown = unsubChanges;
    } else {
      if (!config.getClient(targetKey)) {
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

  function refreshWatchedTarget(
    targetKey: string,
    target: SourceControlDiscoveryTarget<TKey>,
    client?: SourceControlDiscoveryClient,
  ): void {
    refreshTargets.set(targetKey, target);
    if (client) {
      void refresh(target, client);
      return;
    }

    config.getRegistry().get(watchedRefreshAtom(targetKey));
  }

  /**
   * Clear in-flight refresh tracking and reset every known discovery atom.
   * Primarily used by tests and runtime teardown.
   */
  function reset(): void {
    const keys = new Set([...knownSourceControlDiscoveryKeys, ...refreshInFlight.keys()]);
    for (const entry of watched.values()) {
      entry.teardown();
    }
    watched.clear();
    refreshTargets.clear();
    refreshInFlight.clear();
    for (const key of keys) {
      bumpRefreshVersion(key);
      setState(key, INITIAL_SOURCE_CONTROL_DISCOVERY_STATE);
    }
  }

  return {
    watch,
    refresh,
    getSnapshot,
    invalidate,
    reset,
  };
}
