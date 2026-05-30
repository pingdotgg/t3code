import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo } from "react";
import {
  type VcsRefState,
  type VcsRefTarget,
  EMPTY_VCS_REF_ATOM,
  EMPTY_VCS_REF_STATE,
  createVcsRefManager,
  getVcsRefTargetKey,
  vcsRefStateAtom,
} from "@t3tools/client-runtime";

import { appAtomRegistry } from "./atom-registry";
import {
  getEnvironmentClient,
  subscribeEnvironmentConnections,
} from "./environment-session-registry";

const VCS_REF_LIST_LIMIT = 100;
const VCS_REF_STALE_TIME_MS = 5_000;

export const vcsRefManager = createVcsRefManager({
  getRegistry: () => appAtomRegistry,
  getClient: (environmentId) => {
    const client = getEnvironmentClient(environmentId);
    return client ? client.vcs : null;
  },
  subscribeClientChanges: subscribeEnvironmentConnections,
  watchLimit: VCS_REF_LIST_LIMIT,
  staleTimeMs: VCS_REF_STALE_TIME_MS,
  onBackgroundError: (error) => {
    console.warn("[vcs-refs] background refresh failed", error);
  },
});

export function useVcsRefs(target: VcsRefTarget): VcsRefState {
  const stableTarget = useMemo(
    () => ({
      environmentId: target.environmentId,
      cwd: target.cwd,
      query: target.query ?? null,
    }),
    [target.cwd, target.environmentId, target.query],
  );
  const targetKey = getVcsRefTargetKey(stableTarget);

  useEffect(() => vcsRefManager.watch(stableTarget), [stableTarget]);

  const state = useAtomValue(targetKey !== null ? vcsRefStateAtom(targetKey) : EMPTY_VCS_REF_ATOM);
  return targetKey === null ? EMPTY_VCS_REF_STATE : state;
}
