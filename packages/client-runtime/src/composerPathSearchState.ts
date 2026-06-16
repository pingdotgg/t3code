import type { EnvironmentId, ProjectSearchEntriesResult } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

export interface ComposerPathSearchEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
}

export interface ComposerPathSearchState {
  readonly entries: ReadonlyArray<ComposerPathSearchEntry>;
  readonly isPending: boolean;
  readonly error: string | null;
}

export interface ComposerPathSearchTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly query: string | null;
}

export interface ComposerPathSearchClient {
  readonly searchEntries: (input: {
    readonly cwd: string;
    readonly query: string;
    readonly limit: number;
  }) => Promise<ProjectSearchEntriesResult>;
}

interface WatchedEntry {
  refCount: number;
  target: ComposerPathSearchTarget & {
    readonly environmentId: EnvironmentId;
    readonly cwd: string;
  };
  teardown: () => void;
}

export const EMPTY_COMPOSER_PATH_SEARCH_STATE = Object.freeze<ComposerPathSearchState>({
  entries: [],
  isPending: false,
  error: null,
});

const PENDING_COMPOSER_PATH_SEARCH_STATE = Object.freeze<ComposerPathSearchState>({
  entries: [],
  isPending: true,
  error: null,
});

const NOOP: () => void = () => undefined;
const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_LIMIT = 20;

export const composerPathSearchStateAtom = Atom.family((key: string) =>
  Atom.make(EMPTY_COMPOSER_PATH_SEARCH_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`composer-path-search:${key}`),
  ),
);

export const EMPTY_COMPOSER_PATH_SEARCH_ATOM = Atom.make(EMPTY_COMPOSER_PATH_SEARCH_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("composer-path-search:null"),
);

export function normalizeComposerPathSearchQuery(query: string | null): string {
  return query?.trim() ?? "";
}

export function getComposerPathSearchTargetKey(target: ComposerPathSearchTarget): string | null {
  const query = normalizeComposerPathSearchQuery(target.query);
  if (target.environmentId === null || target.cwd === null || query.length === 0) {
    return null;
  }

  return `${target.environmentId}:${target.cwd}:${query}`;
}

function toSearchEntries(
  entries: ProjectSearchEntriesResult["entries"],
): ReadonlyArray<ComposerPathSearchEntry> {
  return entries;
}

export function createComposerPathSearchManager(config: {
  readonly getRegistry: () => AtomRegistry.AtomRegistry;
  readonly getClient: (environmentId: EnvironmentId) => ComposerPathSearchClient | null;
  readonly subscribeClientChanges?: (listener: () => void) => () => void;
  readonly debounceMs?: number;
  readonly limit?: number;
  readonly staleTimeMs?: number;
}) {
  const watched = new Map<string, WatchedEntry>();
  const versions = new Map<string, number>();
  const timers = new Map<string, Fiber.Fiber<void, never>>();
  const lastLoadedAt = new Map<string, number>();
  const debounceMs = config.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const limit = config.limit ?? DEFAULT_LIMIT;

  function bumpVersion(targetKey: string): number {
    const next = (versions.get(targetKey) ?? 0) + 1;
    versions.set(targetKey, next);
    return next;
  }

  function setState(targetKey: string, state: ComposerPathSearchState): void {
    config.getRegistry().set(composerPathSearchStateAtom(targetKey), state);
  }

  function clearTimer(targetKey: string): void {
    const fiber = timers.get(targetKey);
    if (fiber) {
      Effect.runFork(Fiber.interrupt(fiber));
      timers.delete(targetKey);
    }
  }

  function getSnapshot(target: ComposerPathSearchTarget): ComposerPathSearchState {
    const targetKey = getComposerPathSearchTargetKey(target);
    return targetKey === null
      ? EMPTY_COMPOSER_PATH_SEARCH_STATE
      : config.getRegistry().get(composerPathSearchStateAtom(targetKey));
  }

  function runSearch(
    targetKey: string,
    target: ComposerPathSearchTarget & {
      readonly environmentId: EnvironmentId;
      readonly cwd: string;
    },
    client: ComposerPathSearchClient,
    version: number,
  ): void {
    void client
      .searchEntries({
        cwd: target.cwd,
        query: normalizeComposerPathSearchQuery(target.query),
        limit,
      })
      .then((result) => {
        if (versions.get(targetKey) !== version) {
          return;
        }
        setState(targetKey, {
          entries: toSearchEntries(result.entries),
          isPending: false,
          error: null,
        });
        lastLoadedAt.set(targetKey, Effect.runSync(Clock.currentTimeMillis));
      })
      .catch((error: unknown) => {
        if (versions.get(targetKey) !== version) {
          return;
        }
        const current = config.getRegistry().get(composerPathSearchStateAtom(targetKey));
        setState(targetKey, {
          entries: current.entries,
          isPending: false,
          error: error instanceof Error ? error.message : "Failed to search project files.",
        });
      });
  }

  function search(
    target: ComposerPathSearchTarget,
    client?: ComposerPathSearchClient,
    options?: { readonly force?: boolean },
  ): void {
    const targetKey = getComposerPathSearchTargetKey(target);
    if (targetKey === null || target.environmentId === null || target.cwd === null) {
      return;
    }

    const resolved = client ?? config.getClient(target.environmentId);
    if (!resolved) {
      setState(targetKey, {
        entries: [],
        isPending: false,
        error: "Remote connection is not ready.",
      });
      return;
    }

    const lastLoaded = lastLoadedAt.get(targetKey);
    if (
      !options?.force &&
      lastLoaded !== undefined &&
      config.staleTimeMs !== undefined &&
      Effect.runSync(Clock.currentTimeMillis) - lastLoaded < config.staleTimeMs
    ) {
      return;
    }

    const version = bumpVersion(targetKey);
    clearTimer(targetKey);
    const current = config.getRegistry().get(composerPathSearchStateAtom(targetKey));
    setState(
      targetKey,
      current.entries.length === 0
        ? PENDING_COMPOSER_PATH_SEARCH_STATE
        : { ...current, isPending: true, error: null },
    );

    const readyTarget = {
      ...target,
      environmentId: target.environmentId,
      cwd: target.cwd,
    };

    if (debounceMs <= 0) {
      runSearch(targetKey, readyTarget, resolved, version);
      return;
    }

    const fiber = Effect.runFork(
      Effect.sleep(Duration.millis(debounceMs)).pipe(
        Effect.andThen(
          Effect.sync(() => {
            timers.delete(targetKey);
            runSearch(targetKey, readyTarget, resolved, version);
          }),
        ),
      ),
    );
    timers.set(targetKey, fiber);
  }

  function watch(target: ComposerPathSearchTarget): () => void {
    const targetKey = getComposerPathSearchTargetKey(target);
    if (targetKey === null || target.environmentId === null || target.cwd === null) {
      return NOOP;
    }

    const readyTarget = {
      ...target,
      environmentId: target.environmentId,
      cwd: target.cwd,
    };

    const existing = watched.get(targetKey);
    if (existing) {
      existing.refCount += 1;
      return () => unwatch(targetKey);
    }

    let currentClient: ComposerPathSearchClient | null = null;
    const sync = () => {
      const client = config.getClient(target.environmentId!);
      if (!client) {
        currentClient = null;
        setState(targetKey, {
          entries: [],
          isPending: false,
          error: "Remote connection is not ready.",
        });
        return;
      }

      if (currentClient === client) {
        return;
      }

      currentClient = client;
      search(readyTarget, client);
    };

    const unsubscribe = config.subscribeClientChanges?.(sync) ?? NOOP;
    sync();

    watched.set(targetKey, {
      refCount: 1,
      target: readyTarget,
      teardown: () => {
        unsubscribe();
        clearTimer(targetKey);
        bumpVersion(targetKey);
      },
    });

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

  function reset(): void {
    for (const entry of watched.values()) {
      entry.teardown();
    }
    watched.clear();
    versions.clear();
    for (const targetKey of timers.keys()) {
      clearTimer(targetKey);
    }
    lastLoadedAt.clear();
  }

  function invalidate(target?: ComposerPathSearchTarget): void {
    if (target) {
      const targetKey = getComposerPathSearchTargetKey(target);
      if (targetKey === null) {
        return;
      }
      lastLoadedAt.delete(targetKey);
      const watchedEntry = watched.get(targetKey);
      if (watchedEntry) {
        search(watchedEntry.target, undefined, { force: true });
      }
      return;
    }

    lastLoadedAt.clear();
    for (const watchedEntry of watched.values()) {
      search(watchedEntry.target, undefined, { force: true });
    }
  }

  return {
    invalidate,
    getSnapshot,
    search,
    watch,
    reset,
  };
}
