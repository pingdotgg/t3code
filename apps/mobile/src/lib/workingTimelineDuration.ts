import { formatElapsed } from "@t3tools/shared/orchestrationTiming";

export type WorkingTimelineObservation = {
  readonly startedAt: string;
  readonly observedAtMs: number;
};

export function resolveWorkingTimelineObservation(
  current: WorkingTimelineObservation | null,
  startedAt: string | null,
  nowMs: number,
): WorkingTimelineObservation | null {
  if (startedAt === null) {
    return null;
  }
  if (current?.startedAt === startedAt) {
    return current;
  }
  return { startedAt, observedAtMs: nowMs };
}

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
