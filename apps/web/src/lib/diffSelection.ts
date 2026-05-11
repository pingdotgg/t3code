import type { EnvironmentId, ThreadId, TurnId } from "@forma/contracts";
import type { DiffRouteSearch } from "../diffRouteSearch";
import type { TurnDiffSummary } from "../types";

type InferredCheckpointTurnCountByTurnId = Record<string, number | undefined>;

export interface CheckpointRange {
  fromTurnCount: number;
  toTurnCount: number;
}

export interface ResolvedActiveCheckpointRange {
  kind: "conversation" | "turn" | null;
  selectedTurn: TurnDiffSummary | undefined;
  activeRange: CheckpointRange | null;
  cacheScope: string | null;
}

export interface ResolvedLikelyDiffPrefetchTarget extends CheckpointRange {
  kind: "conversation" | "turn";
  environmentId: EnvironmentId;
  threadId: ThreadId;
  cacheScope: string;
}

function resolveCheckpointTurnCount(
  summary: TurnDiffSummary,
  inferredCheckpointTurnCountByTurnId: InferredCheckpointTurnCountByTurnId,
): number | undefined {
  return summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
}

export function orderTurnDiffSummariesByCheckpoint(
  turnDiffSummaries: readonly TurnDiffSummary[],
  inferredCheckpointTurnCountByTurnId: InferredCheckpointTurnCountByTurnId,
): TurnDiffSummary[] {
  return [...turnDiffSummaries].toSorted((left, right) => {
    const leftTurnCount =
      resolveCheckpointTurnCount(left, inferredCheckpointTurnCountByTurnId) ?? 0;
    const rightTurnCount =
      resolveCheckpointTurnCount(right, inferredCheckpointTurnCountByTurnId) ?? 0;
    if (leftTurnCount !== rightTurnCount) {
      return rightTurnCount - leftTurnCount;
    }
    return right.completedAt.localeCompare(left.completedAt);
  });
}

export function resolveConversationCacheScope(
  orderedTurnDiffSummaries: readonly TurnDiffSummary[],
): string | null {
  if (orderedTurnDiffSummaries.length === 0) {
    return null;
  }
  return `conversation:${orderedTurnDiffSummaries.map((summary) => summary.turnId).join(",")}`;
}

export function resolveActiveCheckpointRange(input: {
  orderedTurnDiffSummaries: readonly TurnDiffSummary[];
  inferredCheckpointTurnCountByTurnId: InferredCheckpointTurnCountByTurnId;
  selectedTurnId?: TurnId | null | undefined;
}): ResolvedActiveCheckpointRange {
  const selectedTurnId = input.selectedTurnId ?? null;
  const selectedTurn =
    selectedTurnId === null
      ? undefined
      : (input.orderedTurnDiffSummaries.find((summary) => summary.turnId === selectedTurnId) ??
        input.orderedTurnDiffSummaries[0]);

  if (selectedTurn) {
    const selectedCheckpointTurnCount = resolveCheckpointTurnCount(
      selectedTurn,
      input.inferredCheckpointTurnCountByTurnId,
    );
    if (typeof selectedCheckpointTurnCount !== "number") {
      return {
        kind: "turn",
        selectedTurn,
        activeRange: null,
        cacheScope: `turn:${selectedTurn.turnId}`,
      };
    }

    return {
      kind: "turn",
      selectedTurn,
      activeRange: {
        fromTurnCount: Math.max(0, selectedCheckpointTurnCount - 1),
        toTurnCount: selectedCheckpointTurnCount,
      },
      cacheScope: `turn:${selectedTurn.turnId}`,
    };
  }

  const conversationCheckpointTurnCounts = input.orderedTurnDiffSummaries
    .map((summary) =>
      resolveCheckpointTurnCount(summary, input.inferredCheckpointTurnCountByTurnId),
    )
    .filter((value): value is number => typeof value === "number");

  if (conversationCheckpointTurnCounts.length === 0) {
    return {
      kind: null,
      selectedTurn: undefined,
      activeRange: null,
      cacheScope: null,
    };
  }

  const latestCheckpointTurnCount = Math.max(...conversationCheckpointTurnCounts);
  if (latestCheckpointTurnCount <= 0) {
    return {
      kind: "conversation",
      selectedTurn: undefined,
      activeRange: null,
      cacheScope: resolveConversationCacheScope(input.orderedTurnDiffSummaries),
    };
  }

  return {
    kind: "conversation",
    selectedTurn: undefined,
    activeRange: {
      fromTurnCount: 0,
      toTurnCount: latestCheckpointTurnCount,
    },
    cacheScope: resolveConversationCacheScope(input.orderedTurnDiffSummaries),
  };
}

export function resolveLikelyDiffPrefetchTarget(input: {
  orderedTurnDiffSummaries: readonly TurnDiffSummary[];
  inferredCheckpointTurnCountByTurnId: InferredCheckpointTurnCountByTurnId;
  diffSearch: DiffRouteSearch;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
}): ResolvedLikelyDiffPrefetchTarget | null {
  if (!input.environmentId || !input.threadId) {
    return null;
  }

  const resolved = resolveActiveCheckpointRange({
    orderedTurnDiffSummaries: input.orderedTurnDiffSummaries,
    inferredCheckpointTurnCountByTurnId: input.inferredCheckpointTurnCountByTurnId,
    selectedTurnId: input.diffSearch.diffTurnId ?? null,
  });

  if (!resolved.activeRange || !resolved.cacheScope || !resolved.kind) {
    return null;
  }

  return {
    kind: resolved.kind,
    environmentId: input.environmentId,
    threadId: input.threadId,
    fromTurnCount: resolved.activeRange.fromTurnCount,
    toTurnCount: resolved.activeRange.toTurnCount,
    cacheScope: resolved.cacheScope,
  };
}
