import { useAtomValue } from "@effect/atom-react";
import {
  type CheckpointDiffState,
  type CheckpointDiffTarget,
  checkpointDiffStateAtom,
  createCheckpointDiffManager,
  EMPTY_CHECKPOINT_DIFF_ATOM,
  EMPTY_CHECKPOINT_DIFF_STATE,
  getCheckpointDiffTargetKey,
} from "@t3tools/client-runtime";
import { useEffect, useMemo } from "react";

import { readEnvironmentApi } from "../environmentApi";
import { subscribeProviderInvalidations } from "../environments/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

const checkpointDiffManager = createCheckpointDiffManager({
  getRegistry: () => appAtomRegistry,
  getClient: (environmentId) => readEnvironmentApi(environmentId)?.orchestration ?? null,
});

export function invalidateCheckpointDiffs(): void {
  checkpointDiffManager.invalidate();
}

subscribeProviderInvalidations(invalidateCheckpointDiffs);

export function useCheckpointDiff(
  target: CheckpointDiffTarget,
  options?: { readonly enabled?: boolean },
): CheckpointDiffState {
  const stableTarget = useMemo(
    () => ({
      environmentId: target.environmentId,
      threadId: target.threadId,
      fromTurnCount: target.fromTurnCount,
      toTurnCount: target.toTurnCount,
      ignoreWhitespace: target.ignoreWhitespace,
      cacheScope: target.cacheScope ?? null,
    }),
    [
      target.cacheScope,
      target.environmentId,
      target.fromTurnCount,
      target.ignoreWhitespace,
      target.threadId,
      target.toTurnCount,
    ],
  );
  const targetKey = getCheckpointDiffTargetKey(stableTarget);

  useEffect(() => {
    if (targetKey === null || options?.enabled === false) {
      return;
    }
    void checkpointDiffManager.load(stableTarget);
  }, [options?.enabled, stableTarget, targetKey]);

  const state = useAtomValue(
    targetKey !== null ? checkpointDiffStateAtom(targetKey) : EMPTY_CHECKPOINT_DIFF_ATOM,
  );
  return targetKey === null || options?.enabled === false ? EMPTY_CHECKPOINT_DIFF_STATE : state;
}
