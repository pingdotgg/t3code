import type { SourceControlDiscoveryResult } from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

/* --- Types ---------------------------------------------------------- */

export interface SourceControlDiscoveryState {
  readonly data: SourceControlDiscoveryResult | null;
  readonly error: string | null;
  readonly isPending: boolean;
}

export interface SourceControlDiscoveryTarget {
  readonly key: string | null;
}

export interface SourceControlDiscoveryClient {
  readonly discoverSourceControl: () => Promise<SourceControlDiscoveryResult>;
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

export function getSourceControlDiscoveryTargetKey(
  target: SourceControlDiscoveryTarget,
): string | null {
  const key = target.key?.trim();
  return key && key.length > 0 ? key : null;
}

/* --- Refresh manager ------------------------------------------------ */

export interface SourceControlDiscoveryManagerConfig {
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
  readonly getClient: (key: string) => SourceControlDiscoveryClient | null;
}

export function createSourceControlDiscoveryManager(config: SourceControlDiscoveryManagerConfig) {
  const refreshInFlight = new Map<string, Promise<SourceControlDiscoveryResult | null>>();

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
    target: SourceControlDiscoveryTarget,
    client?: SourceControlDiscoveryClient,
  ): Promise<SourceControlDiscoveryResult | null> {
    const targetKey = getSourceControlDiscoveryTargetKey(target);
    if (targetKey === null) {
      return Promise.resolve(null);
    }

    const existing = refreshInFlight.get(targetKey);
    if (existing) {
      return existing;
    }

    const resolvedClient = client ?? config.getClient(targetKey);
    if (!resolvedClient) {
      const error = new Error("Source control discovery client is unavailable.");
      setError(targetKey, error);
      return Promise.resolve(getSnapshot(target).data);
    }

    markPending(targetKey);
    const promise = resolvedClient.discoverSourceControl().then(
      (result) => {
        setData(targetKey, result);
        return result;
      },
      (error: unknown) => {
        setError(targetKey, error);
        return getSnapshot(target).data;
      },
    );
    const tracked = promise.finally(() => refreshInFlight.delete(targetKey));
    refreshInFlight.set(targetKey, tracked);
    return tracked;
  }

  /**
   * Read the current atom snapshot for `target`.
   *
   * Invalid targets return the inert empty state rather than creating a new
   * family atom entry.
   */
  function getSnapshot(target: SourceControlDiscoveryTarget): SourceControlDiscoveryState {
    const targetKey = getSourceControlDiscoveryTargetKey(target);
    if (targetKey === null) {
      return EMPTY_SOURCE_CONTROL_DISCOVERY_STATE;
    }

    return config.getRegistry().get(sourceControlDiscoveryStateAtom(targetKey));
  }

  /**
   * Clear in-flight refresh tracking and reset every known discovery atom.
   * Primarily used by tests and runtime teardown.
   */
  function reset(): void {
    refreshInFlight.clear();
    for (const key of knownSourceControlDiscoveryKeys) {
      setState(key, INITIAL_SOURCE_CONTROL_DISCOVERY_STATE);
    }
    knownSourceControlDiscoveryKeys.clear();
  }

  return {
    refresh,
    getSnapshot,
    reset,
  };
}
