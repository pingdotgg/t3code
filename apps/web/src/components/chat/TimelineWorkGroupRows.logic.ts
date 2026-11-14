import { toServerClock } from "@t3tools/client-runtime/clock";
import type { EnvironmentId } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";

export function formatWorkingTimerNow(startIso: string, environmentId: EnvironmentId): string {
  const startedAtMs = Date.parse(startIso);
  if (!Number.isFinite(startedAtMs)) {
    return "0s";
  }

  const elapsedSeconds = Math.max(
    0,
    Math.floor((toServerClock(environmentId, Date.now()) - startedAtMs) / 1000),
  );
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  return formatDuration(elapsedSeconds * 1_000);
}
