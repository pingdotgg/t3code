import type { OrchestrationV2Run, OrchestrationV2RunAttempt } from "@t3tools/contracts";

export const terminalRunProjectionStatuses: ReadonlyArray<OrchestrationV2Run["status"]> = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
];

/** Merge full snapshots without letting concurrent metadata writes undo an attempt's finish. */
export function preserveRunRecordedFields(
  current: OrchestrationV2Run | undefined,
  next: OrchestrationV2Run,
  attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "id" | "runId" | "attemptOrdinal">> = [],
): OrchestrationV2Run {
  if (current === undefined) return next;
  const currentAttempt = attempts.find(
    (attempt) => attempt.id === current.activeAttemptId && attempt.runId === current.id,
  );
  const incomingAttempt = attempts.find(
    (attempt) => attempt.id === next.activeAttemptId && attempt.runId === current.id,
  );
  const olderAttempt =
    current.activeAttemptId !== null &&
    (next.activeAttemptId === null ||
      (currentAttempt !== undefined &&
        incomingAttempt !== undefined &&
        incomingAttempt.attemptOrdinal < currentAttempt.attemptOrdinal));
  if (olderAttempt) {
    return {
      ...current,
      ...(next.delegatedCompletion !== undefined
        ? { delegatedCompletion: next.delegatedCompletion }
        : {}),
      ...(next.restartCancelledBackgroundWork !== undefined
        ? { restartCancelledBackgroundWork: next.restartCancelledBackgroundWork }
        : {}),
    };
  }
  const sameAttempt = current.activeAttemptId === next.activeAttemptId;
  const currentTerminal = terminalRunProjectionStatuses.includes(current.status);
  const nextTerminal = terminalRunProjectionStatuses.includes(next.status);
  // Workspace setup retry is the one intentional same-attempt revival.
  const workspaceRetry = current.status === "failed" && next.status === "preparing";
  const staleLifecycle =
    sameAttempt &&
    currentTerminal &&
    !workspaceRetry &&
    (!nextTerminal || (current.status === "rolled_back" && next.status !== "rolled_back"));
  return {
    ...next,
    ...(staleLifecycle ? { status: current.status } : {}),
    ...(staleLifecycle ||
    (sameAttempt && currentTerminal && nextTerminal && next.completedAt === null)
      ? { completedAt: current.completedAt }
      : {}),
    ...(sameAttempt && next.checkpointId === null && current.checkpointId !== null
      ? { checkpointId: current.checkpointId }
      : {}),
    ...(next.delegatedCompletion === undefined && current.delegatedCompletion !== undefined
      ? { delegatedCompletion: current.delegatedCompletion }
      : {}),
    ...(next.restartCancelledBackgroundWork === undefined &&
    current.restartCancelledBackgroundWork !== undefined
      ? { restartCancelledBackgroundWork: current.restartCancelledBackgroundWork }
      : {}),
  };
}
