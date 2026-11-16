import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";

export function unsentManualContinuationSource(
  run: OrchestrationV2Run | undefined,
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "attempts" | "providerTurns">,
) {
  let sourceId = run?.manualContinuationOfRunId;
  if (sourceId === undefined) return undefined;
  const runs = new Map(projection.runs.map((source) => [source.id, source]));
  const acceptedAttempts = new Set(projection.providerTurns.map((turn) => turn.runAttemptId));
  const latestAttempt = (
    runId: OrchestrationV2Run["id"],
    matches: (attempt: (typeof projection.attempts)[number]) => boolean,
  ) =>
    Math.max(
      0,
      ...projection.attempts
        .filter((attempt) => attempt.runId === runId && matches(attempt))
        .map((attempt) => attempt.attemptOrdinal),
    );
  const visited = new Set<OrchestrationV2Run["id"]>();
  while (sourceId !== undefined && !visited.has(sourceId)) {
    visited.add(sourceId);
    const source = runs.get(sourceId);
    if (source === undefined) return undefined;
    const accepted = latestAttempt(sourceId, (attempt) => acceptedAttempts.has(attempt.id));
    // An accepted attempt delivered everything before it; only a later steering restart's message is unsent.
    const restarted = latestAttempt(sourceId, (attempt) => attempt.reason === "steering_restart");
    if (restarted > accepted) return source;
    if (accepted > 0) return undefined;
    if (source.manualContinuationOfRunId === undefined) return source;
    sourceId = source.manualContinuationOfRunId;
  }
  return undefined;
}
