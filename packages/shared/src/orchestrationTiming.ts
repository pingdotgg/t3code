type LatestRunTiming = {
  readonly runId: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
};

type RuntimeActivityState = {
  readonly orchestrationStatus: string;
  readonly activeRunId?: string | null;
};

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  if (seconds === 0) return `${minutes}m`;
  if (seconds === 60) return `${minutes + 1}m`;
  return `${minutes}m ${seconds}s`;
}

export function formatElapsed(startIso: string, endIso: string | undefined): string | null {
  if (!endIso) return null;
  const startedAt = Date.parse(startIso);
  const endedAt = Date.parse(endIso);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) {
    return null;
  }
  return formatDuration(endedAt - startedAt);
}

export function isLatestRunSettled(
  latestRun: LatestRunTiming | null,
  runtime: RuntimeActivityState | null,
): boolean {
  if (!latestRun?.startedAt) return false;
  if (!latestRun.completedAt) return false;
  if (!runtime) return true;
  if (runtime.orchestrationStatus === "running") return false;
  return true;
}

export function deriveActiveWorkStartedAt(
  latestRun: LatestRunTiming | null,
  runtime: RuntimeActivityState | null,
  sendStartedAt: string | null,
): string | null {
  if (!isLatestRunSettled(latestRun, runtime)) {
    return latestRun?.startedAt ?? sendStartedAt;
  }
  return sendStartedAt;
}
