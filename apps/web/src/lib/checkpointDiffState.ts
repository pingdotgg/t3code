import {
  type CheckpointDiffState,
  type CheckpointDiffTarget,
} from "@t3tools/client-runtime/state/threads";

import { useCheckpointDiff as useCheckpointDiffQuery } from "../state/queries";

export function useCheckpointDiff(
  target: CheckpointDiffTarget,
  options?: { readonly enabled?: boolean },
): CheckpointDiffState {
  const state = useCheckpointDiffQuery(target, options);
  return {
    data: state.data,
    error: state.error,
    isPending: state.isPending,
  };
}
