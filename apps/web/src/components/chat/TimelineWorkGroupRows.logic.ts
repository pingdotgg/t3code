import { toServerClock } from "@t3tools/client-runtime/clock";
import type { EnvironmentId } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTimingCopy";
import { msg } from "gt-react";
import { m } from "~/i18n/messages";

export function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  return formatWorkingDuration(endedAtMs - startedAtMs);
}

export function formatWorkingDuration(elapsedMs: number): string {
  const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (elapsedSeconds < 60) {
    return m(msg("{seconds}s", { seconds: elapsedSeconds }));
  }

  return formatDuration(elapsedSeconds * 1_000, m);
}

export function formatWorkingTimerNow(
  startIso: string,
  environmentId: EnvironmentId,
  clock = false,
): string {
  if (clock) {
    const seconds =
      Math.max(
        0,
        Math.floor((toServerClock(environmentId, Date.now()) - Date.parse(startIso)) / 1000),
      ) || 0;
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }
  const startedAtMs = Date.parse(startIso);
  if (!Number.isFinite(startedAtMs)) {
    return m(msg("{seconds}s", { seconds: 0 }));
  }

  const elapsedSeconds = Math.max(
    0,
    Math.floor((toServerClock(environmentId, Date.now()) - startedAtMs) / 1000),
  );
  if (elapsedSeconds < 60) {
    return m(msg("{seconds}s", { seconds: elapsedSeconds }));
  }

  return formatDuration(elapsedSeconds * 1_000, m);
}
