import { useAtomValue } from "@effect/atom-react";
import {
  type GitStatusState,
  type GitStatusTarget,
  EMPTY_GIT_STATUS_ATOM,
  EMPTY_GIT_STATUS_STATE,
  createGitStatusManager,
  getGitStatusTargetKey,
  gitStatusStateAtom,
} from "@t3tools/client-runtime";
import { useEffect } from "react";

import { appAtomRegistry } from "./atom-registry";
import {
  getEnvironmentClient,
  subscribeEnvironmentConnections,
} from "./use-remote-environment-registry";

/**
 * Singleton git status manager for the mobile app.
 *
 * Uses ref-counted `onStatus` subscriptions (one per unique cwd)
 * rather than one-shot `refreshStatus` RPCs. Multiple threads
 * sharing the same cwd (i.e. same project, no worktree) share
 * a single WS subscription.
 *
 * `subscribeClientChanges` ensures subscriptions are established
 * even when the WS connection isn't ready at mount time, and
 * re-established on reconnection.
 */
export const gitStatusManager = createGitStatusManager({
  getRegistry: () => appAtomRegistry,
  getClient: (environmentId) => {
    const client = getEnvironmentClient(environmentId);
    return client ? client.git : null;
  },
  getClientIdentity: (environmentId) => {
    return getEnvironmentClient(environmentId) ? environmentId : null;
  },
  subscribeClientChanges: subscribeEnvironmentConnections,
});

/**
 * Subscribe to live git status for a target (environmentId + cwd).
 *
 * Mirrors the web's `useGitStatus` hook. Automatically subscribes
 * on mount, ref-counts shared cwds, and unsubscribes on unmount.
 * Returns reactive `GitStatusState` via Effect atoms.
 */
export function useGitStatus(target: GitStatusTarget): GitStatusState {
  const targetKey = getGitStatusTargetKey(target);

  useEffect(
    () => gitStatusManager.watch({ environmentId: target.environmentId, cwd: target.cwd }),
    [target.environmentId, target.cwd],
  );

  const state = useAtomValue(
    targetKey !== null ? gitStatusStateAtom(targetKey) : EMPTY_GIT_STATUS_ATOM,
  );
  return targetKey === null ? EMPTY_GIT_STATUS_STATE : state;
}
