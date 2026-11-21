import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

/** @public */
export function formatDuration(durationMs: number, resolve: MFunctionType = mFallback): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return resolve(msg("{ms}ms", { ms: 0 }));
  if (durationMs < 1_000) {
    return resolve(msg("{ms}ms", { ms: Math.max(1, Math.round(durationMs)) }));
  }
  if (durationMs < 10_000) {
    return resolve(msg("{seconds}s", { seconds: Math.round(durationMs / 100) / 10 }));
  }
  const totalSeconds = Math.round(durationMs / 1_000);
  // Choose the unit after rounding so 59.5 seconds never renders as "60s".
  if (totalSeconds < 60) return resolve(msg("{seconds}s", { seconds: totalSeconds }));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours === 0) return resolve(msg("{minutes}m {seconds}s", { minutes, seconds }));
  if (minutes > 0) {
    return resolve(msg("{hours}h {minutes}m {seconds}s", { hours, minutes, seconds }));
  }
  return seconds > 0
    ? resolve(msg("{hours}h {seconds}s", { hours, seconds }))
    : resolve(msg("{hours}h", { hours }));
}

export function formatLiveDuration(durationMs: number, resolve: MFunctionType = mFallback): string {
  const seconds = Number.isFinite(durationMs) ? Math.max(0, Math.floor(durationMs / 1_000)) : 0;
  return seconds === 0
    ? resolve(msg("{seconds}s", { seconds: 0 }))
    : formatDuration(seconds * 1_000, resolve);
}
