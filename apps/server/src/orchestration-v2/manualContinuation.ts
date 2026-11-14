import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";

export function unsentManualContinuationSource(
  run: OrchestrationV2Run | undefined,
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "attempts" | "providerTurns">,
) {
  let sourceId = run?.manualContinuationOfRunId;
  if (sourceId === undefined) return undefined;
  const runs = new Map(projection.runs.map((source) => [source.id, source]));
  const acceptedAttempts = new Set(projection.providerTurns.map((turn) => turn.runAttemptId));
  const acceptedRuns = new Set(
    projection.attempts
      .filter((attempt) => acceptedAttempts.has(attempt.id))
      .map((attempt) => attempt.runId),
  );
  const visited = new Set<OrchestrationV2Run["id"]>();
  while (sourceId !== undefined && !visited.has(sourceId)) {
    visited.add(sourceId);
    const source = runs.get(sourceId);
    if (source === undefined || acceptedRuns.has(sourceId)) return undefined;
    if (source.manualContinuationOfRunId === undefined) return source;
    sourceId = source.manualContinuationOfRunId;
  }
  return undefined;
}
