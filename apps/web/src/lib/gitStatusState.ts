import { useAtomValue } from "@effect/atom-react";
import { type GitManagerServiceError, type GitStatusResult } from "@t3tools/contracts";
import { Cause } from "effect";
import { Atom } from "effect/unstable/reactivity";
import { useEffect } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { getWsRpcClient, type WsRpcClient } from "../wsRpcClient";

export type GitStatusStreamError = GitManagerServiceError;

export interface GitStatusState {
  readonly data: GitStatusResult | null;
  readonly error: GitStatusStreamError | null;
  readonly cause: Cause.Cause<GitStatusStreamError> | null;
  readonly isPending: boolean;
}

type GitStatusClient = Pick<WsRpcClient["git"], "onStatus" | "refreshStatus">;

interface WatchedGitStatus {
  refCount: number;
  unsubscribe: () => void;
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
const knownGitStatusCwds = new Set<string>();
const gitStatusRefreshInFlight = new Map<string, Promise<GitStatusResult>>();
const gitStatusLastRefreshAtByCwd = new Map<string, number>();

const GIT_STATUS_REFRESH_DEBOUNCE_MS = 1_000;

let sharedGitStatusClient: GitStatusClient | null = null;

const gitStatusStateAtom = Atom.family((cwd: string) => {
  knownGitStatusCwds.add(cwd);
  return Atom.make(INITIAL_GIT_STATUS_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`git-status:${cwd}`),
  );
});

export function getGitStatusSnapshot(cwd: string | null): GitStatusState {
  if (cwd === null) {
    return EMPTY_GIT_STATUS_STATE;
  }

  return appAtomRegistry.get(gitStatusStateAtom(cwd));
}

export function watchGitStatus(
  cwd: string | null,
  client: GitStatusClient = getWsRpcClient().git,
): () => void {
  if (cwd === null) {
    return NOOP;
  }

  ensureGitStatusClient(client);

  const watched = watchedGitStatuses.get(cwd);
  if (watched) {
    watched.refCount += 1;
    return () => unwatchGitStatus(cwd);
  }

  watchedGitStatuses.set(cwd, {
    refCount: 1,
    unsubscribe: subscribeToGitStatus(cwd),
  });

  return () => unwatchGitStatus(cwd);
}

export function refreshGitStatus(
  cwd: string | null,
  client: GitStatusClient = getWsRpcClient().git,
): Promise<GitStatusResult | null> {
  if (cwd === null) {
    return Promise.resolve(null);
  }

  ensureGitStatusClient(client);

  const currentInFlight = gitStatusRefreshInFlight.get(cwd);
  if (currentInFlight) {
    return currentInFlight;
  }

  const lastRequestedAt = gitStatusLastRefreshAtByCwd.get(cwd) ?? 0;
  if (Date.now() - lastRequestedAt < GIT_STATUS_REFRESH_DEBOUNCE_MS) {
    return Promise.resolve(getGitStatusSnapshot(cwd).data);
  }

  gitStatusLastRefreshAtByCwd.set(cwd, Date.now());
  const refreshPromise = client.refreshStatus({ cwd }).finally(() => {
    gitStatusRefreshInFlight.delete(cwd);
  });
  gitStatusRefreshInFlight.set(cwd, refreshPromise);
  return refreshPromise;
}

export function resetGitStatusStateForTests(): void {
  for (const watched of watchedGitStatuses.values()) {
    watched.unsubscribe();
  }
  watchedGitStatuses.clear();
  gitStatusRefreshInFlight.clear();
  gitStatusLastRefreshAtByCwd.clear();
  sharedGitStatusClient = null;

  for (const cwd of knownGitStatusCwds) {
    appAtomRegistry.set(gitStatusStateAtom(cwd), INITIAL_GIT_STATUS_STATE);
  }
  knownGitStatusCwds.clear();
}

export function useGitStatus(cwd: string | null): GitStatusState {
  useEffect(() => watchGitStatus(cwd), [cwd]);

  const state = useAtomValue(cwd !== null ? gitStatusStateAtom(cwd) : EMPTY_GIT_STATUS_ATOM);
  return cwd === null ? EMPTY_GIT_STATUS_STATE : state;
}

function ensureGitStatusClient(client: GitStatusClient): void {
  if (sharedGitStatusClient === client) {
    return;
  }

  if (sharedGitStatusClient !== null) {
    resetLiveGitStatusSubscriptions();
  }

  sharedGitStatusClient = client;
}

function resetLiveGitStatusSubscriptions(): void {
  for (const watched of watchedGitStatuses.values()) {
    watched.unsubscribe();
  }
  watchedGitStatuses.clear();
}

function unwatchGitStatus(cwd: string): void {
  const watched = watchedGitStatuses.get(cwd);
  if (!watched) {
    return;
  }

  watched.refCount -= 1;
  if (watched.refCount > 0) {
    return;
  }

  watched.unsubscribe();
  watchedGitStatuses.delete(cwd);
}

function subscribeToGitStatus(cwd: string): () => void {
  const client = sharedGitStatusClient;
  if (!client) {
    return NOOP;
  }

  markGitStatusPending(cwd);
  return client.onStatus(
    { cwd },
    (status) => {
      appAtomRegistry.set(gitStatusStateAtom(cwd), {
        data: status,
        error: null,
        cause: null,
        isPending: false,
      });
    },
    {
      onResubscribe: () => {
        markGitStatusPending(cwd);
      },
    },
  );
}

function markGitStatusPending(cwd: string): void {
  const atom = gitStatusStateAtom(cwd);
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
