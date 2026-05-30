import type { FilesystemBrowseInput, FilesystemBrowseResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

export interface FilesystemBrowseState {
  readonly data: FilesystemBrowseResult | null;
  readonly error: string | null;
  readonly isPending: boolean;
}

export interface FilesystemBrowseTarget<TKey extends string = string> {
  readonly key: TKey | null;
  readonly input: FilesystemBrowseInput | null;
}

export interface FilesystemBrowseClient {
  readonly browse: (input: FilesystemBrowseInput) => Promise<FilesystemBrowseResult>;
}

interface WatchedEntry {
  refCount: number;
  teardown: () => void;
}

export const EMPTY_FILESYSTEM_BROWSE_STATE = Object.freeze<FilesystemBrowseState>({
  data: null,
  error: null,
  isPending: false,
});

const INITIAL_FILESYSTEM_BROWSE_STATE = Object.freeze<FilesystemBrowseState>({
  data: null,
  error: null,
  isPending: true,
});

const knownFilesystemBrowseKeys = new Set<string>();

export const filesystemBrowseStateAtom = Atom.family((targetKey: string) => {
  knownFilesystemBrowseKeys.add(targetKey);
  return Atom.make(INITIAL_FILESYSTEM_BROWSE_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`filesystem-browse:${targetKey}`),
  );
});

export const EMPTY_FILESYSTEM_BROWSE_ATOM = Atom.make(EMPTY_FILESYSTEM_BROWSE_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("filesystem-browse:null"),
);

const NOOP: () => void = () => undefined;
const DEFAULT_STALE_TIME_MS = 30_000;
const DEFAULT_IDLE_TTL_MS = 5 * 60_000;

export function getFilesystemBrowseTargetKey<TKey extends string>(
  target: FilesystemBrowseTarget<TKey>,
): string | null {
  const key = target.key;
  const input = target.input;
  if (!key || !input || input.partialPath.length === 0) {
    return null;
  }

  return JSON.stringify([key, input.cwd ?? null, input.partialPath]);
}

export interface FilesystemBrowseManagerConfig<TKey extends string = string> {
  readonly getRegistry: () => AtomRegistry.AtomRegistry;
  readonly getClient: (key: TKey) => FilesystemBrowseClient | null;
  readonly subscribeClientChanges?: (listener: () => void) => () => void;
  readonly staleTimeMs?: number;
  readonly idleTtlMs?: number;
}

export function createFilesystemBrowseManager<TKey extends string = string>(
  config: FilesystemBrowseManagerConfig<TKey>,
) {
  const refreshInFlight = new Map<
    string,
    {
      readonly client: FilesystemBrowseClient;
      readonly promise: Promise<FilesystemBrowseResult | null>;
    }
  >();
  const refreshVersions = new Map<string, number>();
  const watched = new Map<string, WatchedEntry>();
  const refreshTargets = new Map<string, FilesystemBrowseTarget<TKey>>();
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
      Atom.withLabel(`filesystem-browse:watched-refresh:${targetKey}`),
    ),
  );

  function getRefreshVersion(targetKey: string): number {
    return refreshVersions.get(targetKey) ?? 0;
  }

  function bumpRefreshVersion(targetKey: string): void {
    refreshVersions.set(targetKey, getRefreshVersion(targetKey) + 1);
  }

  function setState(targetKey: string, nextState: FilesystemBrowseState): void {
    config.getRegistry().set(filesystemBrowseStateAtom(targetKey), nextState);
  }

  function markPending(targetKey: string): void {
    const current = config.getRegistry().get(filesystemBrowseStateAtom(targetKey));
    const next: FilesystemBrowseState =
      current.data === null
        ? INITIAL_FILESYSTEM_BROWSE_STATE
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

  function setData(targetKey: string, data: FilesystemBrowseResult): void {
    setState(targetKey, {
      data,
      error: null,
      isPending: false,
    });
  }

  function setError(targetKey: string, error: unknown): void {
    const current = config.getRegistry().get(filesystemBrowseStateAtom(targetKey));
    setState(targetKey, {
      data: current.data,
      error: error instanceof Error ? error.message : "Failed to browse folder.",
      isPending: false,
    });
  }

  function refresh(
    target: FilesystemBrowseTarget<TKey>,
    client?: FilesystemBrowseClient,
  ): Promise<FilesystemBrowseResult | null> {
    const targetKey = getFilesystemBrowseTargetKey(target);
    if (targetKey === null || target.key === null || target.input === null) {
      return Promise.resolve(null);
    }
    refreshTargets.set(targetKey, target);

    const resolvedClient = client ?? config.getClient(target.key);
    if (!resolvedClient) {
      setError(targetKey, new Error("Filesystem browser client is unavailable."));
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
    const promise = resolvedClient.browse(target.input).then(
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

    let tracked: Promise<FilesystemBrowseResult | null>;
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

  function invalidate(target?: FilesystemBrowseTarget<TKey>): void {
    if (!target) {
      reset();
      return;
    }

    const targetKey = getFilesystemBrowseTargetKey(target);
    if (targetKey === null) {
      return;
    }

    bumpRefreshVersion(targetKey);
    refreshInFlight.delete(targetKey);
    setState(targetKey, INITIAL_FILESYSTEM_BROWSE_STATE);
  }

  function getSnapshot(target: FilesystemBrowseTarget<TKey>): FilesystemBrowseState {
    const targetKey = getFilesystemBrowseTargetKey(target);
    if (targetKey === null) {
      return EMPTY_FILESYSTEM_BROWSE_STATE;
    }

    return config.getRegistry().get(filesystemBrowseStateAtom(targetKey));
  }

  function watch(
    target: FilesystemBrowseTarget<TKey>,
    client?: FilesystemBrowseClient,
  ): () => void {
    const targetKey = getFilesystemBrowseTargetKey(target);
    if (targetKey === null || target.key === null) {
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
      let currentClient: FilesystemBrowseClient | null = null;

      const sync = () => {
        const resolved = config.getClient(target.key!);
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
      if (!config.getClient(target.key)) {
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
    target: FilesystemBrowseTarget<TKey>,
    client?: FilesystemBrowseClient,
  ): void {
    refreshTargets.set(targetKey, target);
    const registry = config.getRegistry();
    void registry.get(watchedRefreshAtom(targetKey));
    if (client) {
      void refresh(target, client);
    }
  }

  function reset(): void {
    refreshInFlight.clear();
    watched.clear();
    refreshTargets.clear();
    for (const targetKey of knownFilesystemBrowseKeys) {
      bumpRefreshVersion(targetKey);
      setState(targetKey, INITIAL_FILESYSTEM_BROWSE_STATE);
    }
  }

  return {
    refresh,
    invalidate,
    getSnapshot,
    watch,
    reset,
  };
}
