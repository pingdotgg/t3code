import { formatElapsed } from "@t3tools/shared/orchestrationTiming";

export function formatWorkingTimelineDuration(
  startedAt: string,
  observedAtMs: number,
  nowMs: number,
): string {
  const parsedStartedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(parsedStartedAtMs)) {
    return "0s";
  }
  const effectiveStartedAtMs = Math.min(parsedStartedAtMs, observedAtMs);

  return (
    formatElapsed(new Date(effectiveStartedAtMs).toISOString(), new Date(nowMs).toISOString()) ??
    "0s"
  );
}
