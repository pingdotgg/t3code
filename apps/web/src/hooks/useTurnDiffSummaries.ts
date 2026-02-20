import type { ProviderEvent } from "@t3tools/contracts";
import { useMemo } from "react";
import { deriveTurnDiffSummaries, inferCheckpointTurnCountByTurnId } from "../session-logic";
import type { Thread, TurnDiffSummary } from "../types";

const derivedTurnDiffSummaryCache = new WeakMap<readonly ProviderEvent[], TurnDiffSummary[]>();

function deriveTurnDiffSummariesCached(events: ProviderEvent[]): TurnDiffSummary[] {
  const cached = derivedTurnDiffSummaryCache.get(events);
  if (cached) {
    return cached;
  }
  const derived = deriveTurnDiffSummaries(events);
  derivedTurnDiffSummaryCache.set(events, derived);
  return derived;
}

export function useTurnDiffSummaries(activeThread: Thread | undefined) {
  const turnDiffSummaries = useMemo(() => {
    if (!activeThread) {
      return [];
    }
    if (activeThread.turnDiffSummaries.length > 0) {
      return activeThread.turnDiffSummaries;
    }
    return deriveTurnDiffSummariesCached(activeThread.events);
  }, [activeThread]);

  const inferredCheckpointTurnCountByTurnId = useMemo(
    () => inferCheckpointTurnCountByTurnId(turnDiffSummaries),
    [turnDiffSummaries],
  );

  return { turnDiffSummaries, inferredCheckpointTurnCountByTurnId };
}
