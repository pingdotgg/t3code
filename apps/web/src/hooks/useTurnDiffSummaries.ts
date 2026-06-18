import { useMemo } from "react";
import { inferCheckpointTurnCountByTurnId } from "../session-logic";
import type { Thread, TurnDiffSummary } from "../types";

export function useTurnDiffSummaries(activeThread: Thread | null | undefined) {
  const turnDiffSummaries = useMemo<ReadonlyArray<TurnDiffSummary>>(() => {
    if (!activeThread) {
      return [];
    }
    return activeThread.checkpoints;
  }, [activeThread]);

  const inferredCheckpointTurnCountByTurnId = useMemo(
    () => inferCheckpointTurnCountByTurnId(turnDiffSummaries),
    [turnDiffSummaries],
  );

  return { turnDiffSummaries, inferredCheckpointTurnCountByTurnId };
}
