import { useAtomValue } from "@effect/atom-react";
import {
  type GitStatusClient,
  type GitStatusState,
  type GitStatusTarget,
  EMPTY_GIT_STATUS_ATOM,
  EMPTY_GIT_STATUS_STATE,
  createGitStatusManager,
  getGitStatusTargetKey,
  gitStatusStateAtom,
} from "@t3tools/client-runtime";
import { type EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../environments/runtime";

export type { GitStatusState, GitStatusTarget };

/* ─── Manager singleton ─────────────────────────────────────────────── */

const manager = createGitStatusManager({
  getRegistry: () => appAtomRegistry,
  getClient: (environmentId) => {
    const connection = readEnvironmentConnection(environmentId as EnvironmentId);
    return connection ? connection.client.git : null;
  },
  getClientIdentity: (environmentId) => {
    const connection = readEnvironmentConnection(environmentId as EnvironmentId);
    return connection ? connection.environmentId : null;
  },
  subscribeClientChanges: subscribeEnvironmentConnections,
});

/* ─── Public API (preserves existing call-sites) ────────────────────── */

export function refreshGitStatus(target: GitStatusTarget, client?: GitStatusClient) {
  return manager.refresh(target, client);
}

export function resetGitStatusStateForTests(): void {
  manager.reset();
}

export function useGitStatus(target: GitStatusTarget): GitStatusState {
  const targetKey = getGitStatusTargetKey(target);
  useEffect(
    () => manager.watch({ environmentId: target.environmentId, cwd: target.cwd }),
    [target.environmentId, target.cwd],
  );

  const state = useAtomValue(
    targetKey !== null ? gitStatusStateAtom(targetKey) : EMPTY_GIT_STATUS_ATOM,
  );
  return targetKey === null ? EMPTY_GIT_STATUS_STATE : state;
}
