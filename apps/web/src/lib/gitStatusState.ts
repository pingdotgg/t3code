import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type GitManagerServiceError,
  type GitStatusResult,
} from "@t3tools/contracts";
import { Cause } from "effect";
import { Atom } from "effect/unstable/reactivity";
import { useEffect } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../environments/runtime";
import type { WsRpcClient } from "~/rpc/wsRpcClient";

interface GitStatusState {
  readonly data: GitStatusResult | null;
  readonly error: GitManagerServiceError | null;
  readonly cause: Cause.Cause<GitManagerServiceError> | null;
  readonly isPending: boolean;
}

type GitStatusClient = Pick<WsRpcClient["git"], "onStatus" | "refreshStatus">;
interface ResolvedGitStatusClient {
  readonly clientIdentity: string;
  readonly client: GitStatusClient;
}

interface WatchedGitStatus {
  refCount: number;
  unsubscribe: () => void;
}

interface GitStatusTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
}

const EMPTY_GIT_STATUS_STATE = Object.freeze<GitStatusState>({
  data: null,
  error: null,
  cause: null,
  isPending: false,
});
const INITIAL_GIT_STATUS_STATE = Object.freeze<GitStatusState>({
  ...EMPTY_GIT_STATUS_STATE,
  isPending: true,
});
const EMPTY_GIT_STATUS_ATOM = Atom.make(EMPTY_GIT_STATUS_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("git-status:null"),
);

const NOOP: () => void = () => undefined;
const watchedGitStatuses = new Map<string, WatchedGitStatus>();
const knownGitStatusKeys = new Set<string>();
const gitStatusRefreshInFlight = new Map<string, Promise<GitStatusResult>>();
const gitStatusLastRefreshAtByKey = new Map<string, number>();

const GIT_STATUS_REFRESH_DEBOUNCE_MS = 1_000;

const gitStatusStateAtom = Atom.family((key: string) => {
  knownGitStatusKeys.add(key);
  return Atom.make(INITIAL_GIT_STATUS_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`git-status:${key}`),
  );
});

function getGitStatusTargetKey(target: GitStatusTarget): string | null {
  if (target.environmentId === null || target.cwd === null) {
    return null;
  }

  return `${target.environmentId}:${target.cwd}`;
}

function readResolvedGitStatusClient(target: GitStatusTarget): ResolvedGitStatusClient | null {
  if (target.environmentId === null) {
    return null;
  }
  const connection = readEnvironmentConnection(target.environmentId);
  return connection
    ? { clientIdentity: connection.environmentId, client: connection.client.git }
    : null;
}

export function getGitStatusSnapshot(target: GitStatusTarget): GitStatusState {
  const targetKey = getGitStatusTargetKey(target);
  if (targetKey === null) {
    return EMPTY_GIT_STATUS_STATE;
  }

  return appAtomRegistry.get(gitStatusStateAtom(targetKey));
}

export function watchGitStatus(target: GitStatusTarget, client?: GitStatusClient): () => void {
  const targetKey = getGitStatusTargetKey(target);
  if (targetKey === null) {
    return NOOP;
  }

  const watched = watchedGitStatuses.get(targetKey);
  if (watched) {
    watched.refCount += 1;
    return () => unwatchGitStatus(targetKey);
  }

  watchedGitStatuses.set(targetKey, {
    refCount: 1,
    unsubscribe: subscribeToGitStatusTarget(targetKey, target, client),
  });

  return () => unwatchGitStatus(targetKey);
}

export function refreshGitStatus(
  target: GitStatusTarget,
  client?: GitStatusClient,
): Promise<GitStatusResult | null> {
  const targetKey = getGitStatusTargetKey(target);
  if (targetKey === null || target.cwd === null) {
    return Promise.resolve(null);
  }

  const resolvedClient = client ?? readResolvedGitStatusClient(target)?.client;
  if (!resolvedClient) {
    return Promise.resolve(getGitStatusSnapshot(target).data);
  }

  const currentInFlight = gitStatusRefreshInFlight.get(targetKey);
  if (currentInFlight) {
    return currentInFlight;
  }

  const lastRequestedAt = gitStatusLastRefreshAtByKey.get(targetKey) ?? 0;
  if (Date.now() - lastRequestedAt < GIT_STATUS_REFRESH_DEBOUNCE_MS) {
    return Promise.resolve(getGitStatusSnapshot(target).data);
  }

  gitStatusLastRefreshAtByKey.set(targetKey, Date.now());
  const refreshPromise = resolvedClient.refreshStatus({ cwd: target.cwd }).finally(() => {
    gitStatusRefreshInFlight.delete(targetKey);
  });
  gitStatusRefreshInFlight.set(targetKey, refreshPromise);
  return refreshPromise;
}

export function resetGitStatusStateForTests(): void {
  for (const watched of watchedGitStatuses.values()) {
    watched.unsubscribe();
  }
  watchedGitStatuses.clear();
  gitStatusRefreshInFlight.clear();
  gitStatusLastRefreshAtByKey.clear();

  for (const key of knownGitStatusKeys) {
    appAtomRegistry.set(gitStatusStateAtom(key), INITIAL_GIT_STATUS_STATE);
  }
  knownGitStatusKeys.clear();
}

export function useGitStatus(target: GitStatusTarget): GitStatusState {
  const targetKey = getGitStatusTargetKey(target);
  useEffect(
    () => watchGitStatus({ environmentId: target.environmentId, cwd: target.cwd }),
    [target.environmentId, target.cwd],
  );

  const state = useAtomValue(
    targetKey !== null ? gitStatusStateAtom(targetKey) : EMPTY_GIT_STATUS_ATOM,
  );
  return targetKey === null ? EMPTY_GIT_STATUS_STATE : state;
}

function unwatchGitStatus(targetKey: string): void {
  const watched = watchedGitStatuses.get(targetKey);
  if (!watched) {
    return;
  }

  watched.refCount -= 1;
  if (watched.refCount > 0) {
    return;
  }

  watched.unsubscribe();
  watchedGitStatuses.delete(targetKey);
}

function subscribeToGitStatusTarget(
  targetKey: string,
  target: GitStatusTarget,
  providedClient?: GitStatusClient,
): () => void {
  if (target.cwd === null) {
    return NOOP;
  }

  const cwd = target.cwd;
  let currentClientIdentity: string | null = null;
  let currentUnsubscribe = NOOP;

  const syncClientSubscription = () => {
    const resolved = providedClient
      ? {
          clientIdentity: `provided:${targetKey}`,
          client: providedClient,
        }
      : readResolvedGitStatusClient(target);

    if (!resolved) {
      if (currentClientIdentity !== null) {
        currentUnsubscribe();
        currentUnsubscribe = NOOP;
        currentClientIdentity = null;
      }
      markGitStatusPending(targetKey);
      return;
    }

    if (currentClientIdentity === resolved.clientIdentity) {
      return;
    }

    currentUnsubscribe();
    currentClientIdentity = resolved.clientIdentity;
    currentUnsubscribe = subscribeToGitStatus(targetKey, cwd, resolved.client);
  };

  const unsubscribeRegistry = providedClient
    ? NOOP
    : subscribeEnvironmentConnections(syncClientSubscription);
  syncClientSubscription();

  return () => {
    unsubscribeRegistry();
    currentUnsubscribe();
  };
}

function subscribeToGitStatus(targetKey: string, cwd: string, client: GitStatusClient): () => void {
  markGitStatusPending(targetKey);
  return client.onStatus(
    { cwd },
    (status: GitStatusResult) => {
      appAtomRegistry.set(gitStatusStateAtom(targetKey), {
        data: status,
        error: null,
        cause: null,
        isPending: false,
      });
    },
    {
      onResubscribe: () => {
        markGitStatusPending(targetKey);
      },
    },
  );
}

function markGitStatusPending(targetKey: string): void {
  const atom = gitStatusStateAtom(targetKey);
  const current = appAtomRegistry.get(atom);
  const next =
    current.data === null
      ? INITIAL_GIT_STATUS_STATE
      : {
          ...current,
          error: null,
          cause: null,
          isPending: true,
        };

  if (
    current.data === next.data &&
    current.error === next.error &&
    current.cause === next.cause &&
    current.isPending === next.isPending
  ) {
    return;
  }

  appAtomRegistry.set(atom, next);
}
