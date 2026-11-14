import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";

export function unsentManualContinuationSource(
  run: OrchestrationV2Run | undefined,
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "attempts" | "providerTurns">,
) {
  let sourceId = run?.manualContinuationOfRunId;
  if (sourceId === undefined) return undefined;
  const runs = new Map(projection.runs.map((source) => [source.id, source]));
  const acceptedAttempts = new Set(projection.providerTurns.map((turn) => turn.runAttemptId));
  // A steering restart replaces the run's message, so only attempts since the latest one carry it.
  const isCurrentMessageAccepted = (runId: OrchestrationV2Run["id"]) => {
    const attempts = projection.attempts.filter((attempt) => attempt.runId === runId);
    const since = Math.max(
      0,
      ...attempts
        .filter((attempt) => attempt.reason === "steering_restart")
        .map((attempt) => attempt.attemptOrdinal),
    );
    return attempts.some(
      (attempt) => attempt.attemptOrdinal >= since && acceptedAttempts.has(attempt.id),
    );
  };
  const visited = new Set<OrchestrationV2Run["id"]>();
  while (sourceId !== undefined && !visited.has(sourceId)) {
    visited.add(sourceId);
    const source = runs.get(sourceId);
    if (source === undefined || isCurrentMessageAccepted(sourceId)) return undefined;
    if (source.manualContinuationOfRunId === undefined) return source;
    sourceId = source.manualContinuationOfRunId;
  }
  return undefined;
}
