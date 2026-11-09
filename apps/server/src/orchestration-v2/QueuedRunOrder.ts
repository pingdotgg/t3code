import type {
  MessageId,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

export function isAutomaticCompletionRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  run: OrchestrationV2Run,
): boolean {
  return projection.messages.some(
    (message) => message.id === run.userMessageId && message.delegatedCompletion !== undefined,
  );
}

export function queuedRunsInDeliveryOrder(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
): ReadonlyArray<OrchestrationV2Run> {
  const automaticCompletionMessageIds = new Set(
    projection.messages
      .filter((message) => message.delegatedCompletion !== undefined)
      .map((message) => message.id),
  );
  return projection.runs
    .filter((run) => run.status === "queued")
    .toSorted((left, right) => {
      const deliveryPriority =
        Number(automaticCompletionMessageIds.has(right.userMessageId)) -
        Number(automaticCompletionMessageIds.has(left.userMessageId));
      return (
        deliveryPriority ||
        (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
        left.ordinal - right.ordinal
      );
    });
}

/**
 * During a drain, earlier candidates may be blocked from starting. Only a
 * privileged save-work message may leapfrog those blocked runs.
 */
export function selectStartableQueuedRun(
  queuedCandidates: ReadonlyArray<OrchestrationV2Run>,
  input: {
    readonly isDrainBlocked: (run: OrchestrationV2Run) => boolean;
    readonly isSaveWorkMessage: (messageId: MessageId) => boolean;
  },
): OrchestrationV2Run | undefined {
  let blockedCandidate = false;
  for (const candidate of queuedCandidates) {
    if (input.isDrainBlocked(candidate)) {
      blockedCandidate = true;
      continue;
    }
    if (blockedCandidate && !input.isSaveWorkMessage(candidate.userMessageId)) {
      continue;
    }
    return candidate;
  }
  return undefined;
}

/**
 * Keep prepare→queue during a drain ahead of later ordinary turns. Later messages
 * get compact queue positions while this run is still preparing, so falling back
 * to ordinal alone can place it behind them.
 */
export function drainBlockedPreparedRunQueuePosition(
  run: {
    readonly queuePosition: number | null | undefined;
    readonly ordinal: number;
  },
  queuedRuns: ReadonlyArray<{
    readonly ordinal: number;
    readonly queuePosition: number | null | undefined;
  }>,
): number {
  if (run.queuePosition != null) return run.queuePosition;
  const laterPositions = queuedRuns
    .filter((candidate) => candidate.ordinal > run.ordinal)
    .map((candidate) => candidate.queuePosition ?? candidate.ordinal);
  if (laterPositions.length === 0) return run.ordinal;
  return Math.min(run.ordinal, ...laterPositions);
}
