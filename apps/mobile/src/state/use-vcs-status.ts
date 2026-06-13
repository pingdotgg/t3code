import { useAtomValue } from "@effect/atom-react";
import {
  type VcsStatusState,
  type VcsStatusTarget,
  EMPTY_VCS_STATUS_ATOM,
  EMPTY_VCS_STATUS_STATE,
  createVcsStatusManager,
  getVcsStatusTargetKey,
  vcsStatusStateAtom,
} from "@t3tools/client-runtime";
import { useEffect } from "react";

import { appAtomRegistry } from "./atom-registry";
import {
  getEnvironmentClient,
  subscribeEnvironmentConnections,
} from "./environment-session-registry";

/**
 * Singleton VCS status manager for the mobile app.
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
export const vcsStatusManager = createVcsStatusManager({
  getRegistry: () => appAtomRegistry,
  getClient: (environmentId) => {
    const client = getEnvironmentClient(environmentId);
    return client ? client.vcs : null;
  },
  getClientIdentity: (environmentId) => {
    return getEnvironmentClient(environmentId) ? environmentId : null;
  },
  subscribeClientChanges: subscribeEnvironmentConnections,
});

/**
 * Subscribe to live VCS status for a target (environmentId + cwd).
 *
 * Mirrors the web's `useVcsStatus` hook. Automatically subscribes
 * on mount, ref-counts shared cwds, and unsubscribes on unmount.
 * Returns reactive `VcsStatusState` via Effect atoms.
 */
export function useVcsStatus(target: VcsStatusTarget): VcsStatusState {
  const targetKey = getVcsStatusTargetKey(target);

  useEffect(
    () => vcsStatusManager.watch({ environmentId: target.environmentId, cwd: target.cwd }),
    [target.environmentId, target.cwd],
  );

  const state = useAtomValue(
    targetKey !== null ? vcsStatusStateAtom(targetKey) : EMPTY_VCS_STATUS_ATOM,
  );
  return targetKey === null ? EMPTY_VCS_STATUS_STATE : state;
}
