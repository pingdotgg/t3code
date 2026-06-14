import { useAtomValue } from "@effect/atom-react";
import {
  type VcsStatusClient,
  type VcsStatusState,
  type VcsStatusTarget,
  EMPTY_VCS_STATUS_ATOM,
  EMPTY_VCS_STATUS_STATE,
  createVcsStatusManager,
  getVcsStatusDataForTarget,
  getVcsStatusTargetKey,
  vcsStatusStateAtom,
} from "@t3tools/client-runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../environments/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export type { VcsStatusState, VcsStatusTarget };
export { getVcsStatusDataForTarget };

const manager = createVcsStatusManager({
  getRegistry: () => appAtomRegistry,
  getClient: (environmentId) => {
    const connection = readEnvironmentConnection(environmentId as EnvironmentId);
    return connection ? connection.client.vcs : null;
  },
  getClientIdentity: (environmentId) => {
    const connection = readEnvironmentConnection(environmentId as EnvironmentId);
    return connection ? connection.environmentId : null;
  },
  subscribeClientChanges: subscribeEnvironmentConnections,
});

export function getVcsStatusSnapshot(target: VcsStatusTarget): VcsStatusState {
  return manager.getSnapshot(target);
}

export function watchVcsStatus(target: VcsStatusTarget, client?: VcsStatusClient): () => void {
  return manager.watch(target, client);
}

export function refreshVcsStatus(target: VcsStatusTarget, client?: VcsStatusClient) {
  return manager.refresh(target, client);
}

export function resetVcsStatusStateForTests(): void {
  manager.reset();
}

export function useVcsStatus(target: VcsStatusTarget): VcsStatusState {
  const targetKey = getVcsStatusTargetKey(target);
  useEffect(
    () => manager.watch({ environmentId: target.environmentId, cwd: target.cwd }),
    [target.environmentId, target.cwd],
  );

  const state = useAtomValue(
    targetKey !== null ? vcsStatusStateAtom(targetKey) : EMPTY_VCS_STATUS_ATOM,
  );
  return targetKey === null ? EMPTY_VCS_STATUS_STATE : state;
}
