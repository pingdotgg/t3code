import {
  type CheckpointDiffState,
  type CheckpointDiffTarget,
} from "@t3tools/client-runtime/state/threads";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { orchestrationEnvironment } from "../state/orchestration";
import { useCheckpointDiff as useCheckpointDiffQuery } from "../state/queries";

export function useCheckpointDiff(
  target: CheckpointDiffTarget,
  options?: { readonly enabled?: boolean },
): CheckpointDiffState & { readonly refresh: () => void } {
  const state = useCheckpointDiffQuery(target, options);
  return {
    data: state.data,
    error: state.error,
    isPending: state.isPending,
    refresh: state.refresh,
  };
}

/** Refresh a checkpoint diff query even when it is not the currently selected scope. */
export function refreshCheckpointDiff(target: CheckpointDiffTarget): void {
  if (
    target.environmentId === null ||
    target.threadId === null ||
    target.fromTurnCount === null ||
    target.toTurnCount === null
  ) {
    return;
  }

  if (target.fromTurnCount === 0) {
    appAtomRegistry.refresh(
      orchestrationEnvironment.fullThreadDiff({
        environmentId: target.environmentId,
        input: {
          threadId: target.threadId,
          toTurnCount: target.toTurnCount,
          ignoreWhitespace: target.ignoreWhitespace,
        },
      }),
    );
    return;
  }

  appAtomRegistry.refresh(
    orchestrationEnvironment.turnDiff({
      environmentId: target.environmentId,
      input: {
        threadId: target.threadId,
        fromTurnCount: target.fromTurnCount,
        toTurnCount: target.toTurnCount,
        ignoreWhitespace: target.ignoreWhitespace,
      },
    }),
  );
}
