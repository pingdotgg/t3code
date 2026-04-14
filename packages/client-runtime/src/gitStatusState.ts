import type { GitManagerServiceError, GitStatusResult } from "@t3tools/contracts";
import type { Cause } from "effect";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";
import type { WsRpcClient } from "./wsRpcClient";

/* ─── Types ─────────────────────────────────────────────────────────── */

export interface GitStatusState {
  readonly data: GitStatusResult | null;
  readonly error: GitManagerServiceError | null;
  readonly cause: Cause.Cause<GitManagerServiceError> | null;
  readonly isPending: boolean;
}

export interface GitStatusTarget {
  readonly environmentId: string | null;
  readonly cwd: string | null;
}

export type GitStatusClient = Pick<WsRpcClient["git"], "onStatus" | "refreshStatus">;

interface WatchedEntry {
  refCount: number;
  teardown: () => void;
}

/* ─── Constants ─────────────────────────────────────────────────────── */

const NOOP: () => void = () => undefined;

export const EMPTY_GIT_STATUS_STATE = Object.freeze<GitStatusState>({
  data: null,
  error: null,
  cause: null,
  isPending: false,
});

const INITIAL_GIT_STATUS_STATE = Object.freeze<GitStatusState>({
  data: null,
  error: null,
  cause: null,
  isPending: true,
});

/* ─── Atoms ─────────────────────────────────────────────────────────── */

const knownGitStatusKeys = new Set<string>();

export const gitStatusStateAtom = Atom.family((key: string) => {
  knownGitStatusKeys.add(key);
  return Atom.make(INITIAL_GIT_STATUS_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`git-status:${key}`),
  );
});

export const EMPTY_GIT_STATUS_ATOM = Atom.make(EMPTY_GIT_STATUS_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("git-status:null"),
);

/* ─── Helpers ───────────────────────────────────────────────────────── */

export function getGitStatusTargetKey(target: GitStatusTarget): string | null {
  if (target.environmentId === null || target.cwd === null) {
    return null;
  }
  return `${target.environmentId}:${target.cwd}`;
}

/* ─── Subscription manager ──────────────────────────────────────────── */

export interface GitStatusManagerConfig {
  /**
   * Get the atom registry to read/write git status atoms.
   */
  readonly getRegistry: () => AtomRegistry.AtomRegistry;
  /** Resolve a git client for an environment. */
  readonly getClient: (environmentId: string) => GitStatusClient | null;
  /**
   * Optional: get a stable identity for the current client.
   * Used to detect reconnections — when the identity changes the
   * manager tears down the old `onStatus` stream and subscribes anew.
   */
  readonly getClientIdentity?: (environmentId: string) => string | null;
  /**
   * Optional: subscribe to environment-connection changes.
   * When provided the manager reacts to client appear / disappear /
   * reconnect events instead of doing a one-shot resolution.
   */
  readonly subscribeClientChanges?: (listener: () => void) => () => void;
}

const GIT_STATUS_REFRESH_DEBOUNCE_MS = 1_000;

export function createGitStatusManager(config: GitStatusManagerConfig) {
  const watched = new Map<string, WatchedEntry>();
  const refreshInFlight = new Map<string, Promise<GitStatusResult>>();
  const lastRefreshAt = new Map<string, number>();

  /* ── Atom helpers ───────────────────────────────────────────────── */

  function markPending(targetKey: string): void {
    const atom = gitStatusStateAtom(targetKey);
    const current = config.getRegistry().get(atom);
    const next: GitStatusState =
      current.data === null
        ? INITIAL_GIT_STATUS_STATE
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

  function setData(targetKey: string, status: GitStatusResult): void {
    config.getRegistry().set(gitStatusStateAtom(targetKey), {
      data: status,
      error: null,
      cause: null,
      isPending: false,
    });
  }

  /* ── Core subscription ──────────────────────────────────────────── */

  function subscribeStream(targetKey: string, cwd: string, client: GitStatusClient): () => void {
    markPending(targetKey);
    return client.onStatus({ cwd }, (status) => setData(targetKey, status), {
      onResubscribe: () => markPending(targetKey),
    });
  }

  /* ── Dynamic subscription (handles reconnection) ────────────────── */

  function createDynamicSubscription(targetKey: string, target: GitStatusTarget): () => void {
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
   * Begin watching git status for `target`.
   *
   * Multiple watchers sharing the same `environmentId:cwd` key share
   * one `onStatus` WS subscription (ref-counted).
   *
   * @param target   The environment + cwd to watch.
   * @param client   Optional pre-resolved client — skips `getClient`
   *                 lookup and reconnection handling. Useful in tests.
   * @returns An unwatch function.
   */
  function watch(target: GitStatusTarget, client?: GitStatusClient): () => void {
    const targetKey = getGitStatusTargetKey(target);
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
    target: GitStatusTarget,
    client?: GitStatusClient,
  ): Promise<GitStatusResult | null> {
    const targetKey = getGitStatusTargetKey(target);
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

    const last = lastRefreshAt.get(targetKey) ?? 0;
    if (Date.now() - last < GIT_STATUS_REFRESH_DEBOUNCE_MS) {
      return Promise.resolve(getSnapshot(target).data);
    }

    lastRefreshAt.set(targetKey, Date.now());
    const promise = resolved
      .refreshStatus({ cwd: target.cwd })
      .finally(() => refreshInFlight.delete(targetKey));
    refreshInFlight.set(targetKey, promise);
    return promise;
  }

  function getSnapshot(target: GitStatusTarget): GitStatusState {
    const targetKey = getGitStatusTargetKey(target);
    if (targetKey === null) return EMPTY_GIT_STATUS_STATE;
    return config.getRegistry().get(gitStatusStateAtom(targetKey));
  }

  function reset(): void {
    for (const entry of watched.values()) {
      entry.teardown();
    }
    watched.clear();
    refreshInFlight.clear();
    lastRefreshAt.clear();
    for (const key of knownGitStatusKeys) {
      config.getRegistry().set(gitStatusStateAtom(key), INITIAL_GIT_STATUS_STATE);
    }
    knownGitStatusKeys.clear();
  }

  return { watch, refresh, getSnapshot, reset };
}
