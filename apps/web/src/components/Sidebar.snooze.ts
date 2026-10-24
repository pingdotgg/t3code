import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  effectiveSnoozed,
  resolveSnoozePresets as resolveSharedSnoozePresets,
  snoozeWakeLabel,
  type SnoozePreset,
  type ThreadSnoozeShell,
} from "@t3tools/client-runtime/state/thread-settled";

import { formatShortTimestamp, parseTimestampDate } from "../timestampFormat";

export { snoozeWakeLabel, type SnoozePreset };

function timeOfDayLabel(date: Date, timestampFormat: TimestampFormat): string {
  return formatShortTimestamp(date.toISOString(), timestampFormat);
}

export function resolveSnoozePresets(
  now: Date,
  timestampFormat: TimestampFormat,
): ReadonlyArray<SnoozePreset> {
  return resolveSharedSnoozePresets(now).map((preset) => {
    const wake = parseTimestampDate(preset.snoozedUntil);
    if (wake === null) return preset;
    const time = timeOfDayLabel(wake, timestampFormat);
    return {
      ...preset,
      whenLabel:
        preset.id === "next-week"
          ? `${wake.toLocaleDateString(undefined, { weekday: "short" })} ${time}`
          : time,
    };
  });
}

/**
 * The wake time an Undo should restore when a snooze is a reschedule: the
 * current wake time of an already-snoozed thread, or null when the thread
 * is awake and Undo should wake it instead.
 */
export function rescheduleUndoTarget(shell: ThreadSnoozeShell | null, now: Date): string | null {
  if (shell === null || !effectiveSnoozed(shell, { now: now.toISOString() })) return null;
  return shell.snoozedUntil ?? null;
}
