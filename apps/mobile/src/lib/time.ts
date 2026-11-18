import { formatDuration } from "@t3tools/shared/orchestrationTimingCopy";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../i18n/messages";

// Host timestamps may carry UTC offsets or mixed fractions, so text order is not time order.
export function compareTimestamps(left: string, right: string): number {
  return (Date.parse(left) || 0) - (Date.parse(right) || 0);
}

export function byTimestamp(newestFirst: boolean) {
  return (left: { readonly date: string }, right: { readonly date: string }) =>
    newestFirst
      ? compareTimestamps(right.date, left.date)
      : compareTimestamps(left.date, right.date);
}

export function relativeTime(
  input: string,
  nowMs: number = Date.now(),
  resolve: MessageResolver = m,
): string {
  const underAMinute = () =>
    resolve(msg("<1m", { $context: "compact elapsed time, under one minute" }));
  const timestamp = Date.parse(input);
  if (Number.isNaN(timestamp)) {
    return underAMinute();
  }

  const deltaSeconds = Math.max(0, Math.floor((nowMs - timestamp) / 1000));
  if (deltaSeconds < 60) return underAMinute();

  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) {
    return resolve(
      msg("{count}m", { count: String(deltaMinutes), $context: "compact elapsed minutes" }),
    );
  }

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) {
    return resolve(
      msg("{count}h", { count: String(deltaHours), $context: "compact elapsed hours" }),
    );
  }

  const deltaDays = Math.floor(deltaHours / 24);
  return resolve(msg("{count}d", { count: String(deltaDays), $context: "compact elapsed days" }));
}

/** Milliseconds until the relative-time label next changes. */
export function msUntilRelativeTimeChange(
  input: string,
  nowMs: number = Date.now(),
): number | null {
  const timestamp = Date.parse(input);
  if (Number.isNaN(timestamp)) return null;
  const elapsedMs = Math.max(0, nowMs - timestamp);
  const unitMs = elapsedMs < 3_600_000 ? 60_000 : elapsedMs < 86_400_000 ? 3_600_000 : 86_400_000;
  const nextChangeMs = timestamp + (Math.floor(elapsedMs / unitMs) + 1) * unitMs;
  // Far-future timestamps must not overflow setTimeout's signed 32-bit delay.
  return Math.min(nextChangeMs - nowMs, 86_400_000);
}

export function formatWorkingDuration(elapsedMs: number, resolve: MessageResolver = m): string {
  const totalSeconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1_000)) : 0;
  if (totalSeconds < 60) return resolve(msg("{seconds}s", { seconds: totalSeconds }));
  if (totalSeconds >= 3_600) return formatDuration(totalSeconds * 1_000, resolve);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return resolve(msg("{minutes}m {seconds}s", { minutes, seconds }));
}
