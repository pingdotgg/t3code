import { useAtomValue } from "@effect/atom-react";
import {
  type ComposerPathSearchState,
  type ComposerPathSearchTarget,
  EMPTY_COMPOSER_PATH_SEARCH_ATOM,
  EMPTY_COMPOSER_PATH_SEARCH_STATE,
  composerPathSearchStateAtom,
  createComposerPathSearchManager,
  getComposerPathSearchTargetKey,
  normalizeComposerPathSearchQuery,
} from "@t3tools/client-runtime";
import { useEffect, useMemo } from "react";

import { appAtomRegistry } from "./atom-registry";
import {
  getEnvironmentClient,
  subscribeEnvironmentConnections,
} from "./environment-session-registry";

const COMPOSER_PATH_SEARCH_STALE_TIME_MS = 15_000;

const composerPathSearchManager = createComposerPathSearchManager({
  getRegistry: () => appAtomRegistry,
  getClient: (environmentId) => getEnvironmentClient(environmentId)?.projects ?? null,
  subscribeClientChanges: subscribeEnvironmentConnections,
  staleTimeMs: COMPOSER_PATH_SEARCH_STALE_TIME_MS,
});

export function useComposerPathSearch(target: ComposerPathSearchTarget): ComposerPathSearchState {
  const stableTarget = useMemo(
    () => ({
      environmentId: target.environmentId,
      cwd: target.cwd,
      query: normalizeComposerPathSearchQuery(target.query),
    }),
    [target.cwd, target.environmentId, target.query],
  );
  const targetKey = getComposerPathSearchTargetKey(stableTarget);

  useEffect(() => composerPathSearchManager.watch(stableTarget), [stableTarget]);

  const state = useAtomValue(
    targetKey !== null ? composerPathSearchStateAtom(targetKey) : EMPTY_COMPOSER_PATH_SEARCH_ATOM,
  );
  return targetKey === null ? EMPTY_COMPOSER_PATH_SEARCH_STATE : state;
}
