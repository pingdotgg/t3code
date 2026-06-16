import type { EnvironmentId, GitManagerServiceError, VcsStatusResult } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";
import type { WsRpcClient } from "./wsRpcClient.ts";

/* ─── Types ─────────────────────────────────────────────────────────── */

export interface VcsStatusState {
  readonly targetKey: string | null;
  readonly data: VcsStatusResult | null;
  readonly error: GitManagerServiceError | null;
  readonly cause: Cause.Cause<GitManagerServiceError> | null;
  readonly isPending: boolean;
}

export interface VcsStatusTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
}

export type VcsStatusClient = Pick<WsRpcClient["vcs"], "onStatus" | "refreshStatus">;

interface WatchedEntry {
  refCount: number;
  teardown: () => void;
}

/* ─── Constants ─────────────────────────────────────────────────────── */

const NOOP: () => void = () => undefined;

export const EMPTY_VCS_STATUS_STATE = Object.freeze<VcsStatusState>({
  targetKey: null,
  data: null,
  error: null,
  cause: null,
  isPending: false,
});

function initialVcsStatusState(targetKey: string): VcsStatusState {
  return {
    targetKey,
    data: null,
    error: null,
    cause: null,
    isPending: true,
  };
}

/* ─── Atoms ─────────────────────────────────────────────────────────── */

const knownVcsStatusKeys = new Set<string>();

export const vcsStatusStateAtom = Atom.family((key: string) => {
  knownVcsStatusKeys.add(key);
  return Atom.make(initialVcsStatusState(key)).pipe(
    Atom.keepAlive,
    Atom.withLabel(`vcs-status:${key}`),
  );
});

export const EMPTY_VCS_STATUS_ATOM = Atom.make(EMPTY_VCS_STATUS_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("vcs-status:null"),
);

/* ─── Helpers ───────────────────────────────────────────────────────── */

export function getVcsStatusTargetKey(target: VcsStatusTarget): string | null {
  if (target.environmentId === null || target.cwd === null) {
    return null;
  }
  return `${target.environmentId}:${target.cwd}`;
}

export function getVcsStatusDataForTarget(
  state: VcsStatusState,
  target: VcsStatusTarget,
): VcsStatusResult | null {
  const targetKey = getVcsStatusTargetKey(target);
  return targetKey !== null && state.targetKey === targetKey ? state.data : null;
}

/* ─── Subscription manager ──────────────────────────────────────────── */

export interface VcsStatusManagerConfig {
  /**
   * Get the atom registry to read/write VCS status atoms.
   */
  readonly getRegistry: () => AtomRegistry.AtomRegistry;
  /** Resolve a VCS client for an environment. */
  readonly getClient: (environmentId: EnvironmentId) => VcsStatusClient | null;
  /**
   * Optional: get a stable identity for the current client.
   * Used to detect reconnections — when the identity changes the
   * manager tears down the old `onStatus` stream and subscribes anew.
   */
  readonly getClientIdentity?: (environmentId: EnvironmentId) => string | null;
  /**
   * Optional: subscribe to environment-connection changes.
   * When provided the manager reacts to client appear / disappear /
   * reconnect events instead of doing a one-shot resolution.
   */
  readonly subscribeClientChanges?: (listener: () => void) => () => void;
}

const VCS_STATUS_REFRESH_DEBOUNCE_MS = 1_000;
const nowMs = () => DateTime.toEpochMillis(DateTime.nowUnsafe());

export function createVcsStatusManager(config: VcsStatusManagerConfig) {
  const watched = new Map<string, WatchedEntry>();
  const refreshInFlight = new Map<string, Promise<VcsStatusResult>>();
  const lastRefreshAt = new Map<string, number>();

  /* ── Atom helpers ───────────────────────────────────────────────── */

  function markPending(targetKey: string): void {
    const atom = vcsStatusStateAtom(targetKey);
    const current = config.getRegistry().get(atom);
    const next: VcsStatusState =
      current.data === null
        ? initialVcsStatusState(targetKey)
        : { ...current, error: null, cause: null, isPending: true };
    if (
      current.data === next.data &&
      current.error === next.error &&
      current.cause === next.cause &&
      current.isPending === next.isPending
    ) {
      return;
    }
    config.getRegistry().set(atom, next);
  }

  function setData(targetKey: string, status: VcsStatusResult): void {
    config.getRegistry().set(vcsStatusStateAtom(targetKey), {
      targetKey,
      data: status,
      error: null,
      cause: null,
      isPending: false,
    });
  }

  /* ── Core subscription ──────────────────────────────────────────── */

  function subscribeStream(targetKey: string, cwd: string, client: VcsStatusClient): () => void {
    markPending(targetKey);
    return client.onStatus({ cwd }, (status) => setData(targetKey, status), {
      onResubscribe: () => markPending(targetKey),
    });
  }

  /* ── Dynamic subscription (handles reconnection) ────────────────── */

  function createDynamicSubscription(targetKey: string, target: VcsStatusTarget): () => void {
    const environmentId = target.environmentId!;
    const cwd = target.cwd!;
    let currentIdentity: string | null = null;
    let currentUnsub = NOOP;

    const sync = () => {
      const client = config.getClient(environmentId);
      const identity = client ? (config.getClientIdentity?.(environmentId) ?? environmentId) : null;

      if (!client || identity === null) {
        if (currentIdentity !== null) {
          currentUnsub();
          currentUnsub = NOOP;
          currentIdentity = null;
        }
        markPending(targetKey);
        return;
      }

      if (currentIdentity === identity) return;

      currentUnsub();
      currentIdentity = identity;
      currentUnsub = subscribeStream(targetKey, cwd, client);
    };

    const unsubChanges = config.subscribeClientChanges!(sync);
    sync();

    return () => {
      unsubChanges();
      currentUnsub();
    };
  }

  /* ── Public API ─────────────────────────────────────────────────── */

  /**
   * Begin watching VCS status for `target`.
   *
   * Multiple watchers sharing the same `environmentId:cwd` key share
   * one `onStatus` WS subscription (ref-counted).
   *
   * @param target   The environment + cwd to watch.
   * @param client   Optional pre-resolved client — skips `getClient`
   *                 lookup and reconnection handling. Useful in tests.
   * @returns An unwatch function.
   */
  function watch(target: VcsStatusTarget, client?: VcsStatusClient): () => void {
    const targetKey = getVcsStatusTargetKey(target);
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
      // Explicit client — direct subscription, no reconnection handling.
      teardown = subscribeStream(targetKey, target.cwd, client);
    } else if (config.subscribeClientChanges) {
      // Dynamic client — subscribe to connection changes for reconnection.
      teardown = createDynamicSubscription(targetKey, target);
    } else {
      // One-shot client resolution.
      const resolved = config.getClient(target.environmentId);
      if (!resolved) return NOOP;
      teardown = subscribeStream(targetKey, target.cwd, resolved);
    }

    watched.set(targetKey, { refCount: 1, teardown });
    return () => unwatch(targetKey);
  }

  function unwatch(targetKey: string): void {
    const entry = watched.get(targetKey);
    if (!entry) return;

    entry.refCount -= 1;
    if (entry.refCount > 0) return;

    entry.teardown();
    watched.delete(targetKey);
  }

  /**
   * Trigger a one-shot `refreshStatus` RPC for a target.
   * Debounced (1 s) and deduplicated (in-flight).
   * The server-side refresh pushes a new event on the existing
   * `onStatus` stream, so the subscription picks it up automatically.
   */
  function refresh(
    target: VcsStatusTarget,
    client?: VcsStatusClient,
  ): Promise<VcsStatusResult | null> {
    const targetKey = getVcsStatusTargetKey(target);
    if (targetKey === null || target.cwd === null) {
      return Promise.resolve(null);
    }

    const resolved =
      client ?? (target.environmentId ? config.getClient(target.environmentId) : null);
    if (!resolved) {
      return Promise.resolve(getSnapshot(target).data);
    }

    const existing = refreshInFlight.get(targetKey);
    if (existing) return existing;

    const requestedAt = nowMs();
    const last = lastRefreshAt.get(targetKey) ?? 0;
    if (requestedAt - last < VCS_STATUS_REFRESH_DEBOUNCE_MS) {
      return Promise.resolve(getSnapshot(target).data);
    }

    lastRefreshAt.set(targetKey, requestedAt);
    const promise = resolved
      .refreshStatus({ cwd: target.cwd })
      .finally(() => refreshInFlight.delete(targetKey));
    refreshInFlight.set(targetKey, promise);
    return promise;
  }

  function getSnapshot(target: VcsStatusTarget): VcsStatusState {
    const targetKey = getVcsStatusTargetKey(target);
    if (targetKey === null) return EMPTY_VCS_STATUS_STATE;
    return config.getRegistry().get(vcsStatusStateAtom(targetKey));
  }

  function reset(): void {
    for (const entry of watched.values()) {
      entry.teardown();
    }
    watched.clear();
    refreshInFlight.clear();
    lastRefreshAt.clear();
    for (const key of knownVcsStatusKeys) {
      config.getRegistry().set(vcsStatusStateAtom(key), initialVcsStatusState(key));
    }
    knownVcsStatusKeys.clear();
  }

  return { watch, refresh, getSnapshot, reset };
}
