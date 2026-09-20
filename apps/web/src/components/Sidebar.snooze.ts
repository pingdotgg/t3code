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

const DAY_MS = 24 * 60 * 60 * 1_000;

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
 * Human wake time for menus and toasts: "tomorrow 9:00", "Mon 9:00",
 * "17:30" (today).
 */
export function snoozeWakeDescription(
  snoozedUntil: string,
  now: Date,
  timestampFormat: TimestampFormat,
): string {
  const wake = parseTimestampDate(snoozedUntil);
  if (wake === null) return "";
  const time = timeOfDayLabel(wake, timestampFormat);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayDelta = Math.floor((wake.getTime() - startOfToday.getTime()) / DAY_MS);
  if (dayDelta === 0) return time;
  if (dayDelta === 1) return `tomorrow ${time}`;
  const weekday = wake.toLocaleDateString(undefined, { weekday: "short" });
  if (dayDelta < 7) return `${weekday} ${time}`;
  const date = wake.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${date}, ${time}`;
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

export type SnoozeUndo =
  | { readonly kind: "stale" }
  | { readonly kind: "wake" }
  | { readonly kind: "restore"; readonly snoozedUntil: string };

// Counts snoozes this client issued per thread. Toasts capture the value so
// an older toast's Undo goes stale after A → B → A even though the wake time
// matches again. Server-side `snoozedAt` cannot serve here: the shell carries
// an optimistic client-clock value until the server snapshot lands.
const snoozeGenerationByThreadKey = new Map<string, number>();

/** Record one more successful snooze for a thread; returns the new generation. */
export function bumpSnoozeGeneration(threadKey: string): number {
  const next = (snoozeGenerationByThreadKey.get(threadKey) ?? 0) + 1;
  snoozeGenerationByThreadKey.set(threadKey, next);
  return next;
}

/** The generation of the latest successful snooze this client issued for a thread. */
export function readSnoozeGeneration(threadKey: string): number {
  return snoozeGenerationByThreadKey.get(threadKey) ?? 0;
}

/**
 * What a snooze toast's Undo should do when clicked. Stale once a later
 * snooze happened (generation moved on) or the thread no longer holds the
 * wake time that toast set (woken, or changed from another client), so an
 * older toast never overwrites a newer choice. Otherwise a reschedule
 * restores the previous wake time and a fresh snooze wakes.
 */
export function resolveSnoozeUndo(input: {
  readonly shell: Pick<ThreadSnoozeShell, "snoozedUntil"> | null;
  readonly snoozedUntilSetByToast: string;
  readonly generationSetByToast: number;
  readonly currentGeneration: number;
  readonly previousWake: string | null;
}): SnoozeUndo {
  if (
    input.shell === null ||
    input.currentGeneration !== input.generationSetByToast ||
    input.shell.snoozedUntil !== input.snoozedUntilSetByToast
  ) {
    return { kind: "stale" };
  }
  return input.previousWake === null
    ? { kind: "wake" }
    : { kind: "restore", snoozedUntil: input.previousWake };
}
