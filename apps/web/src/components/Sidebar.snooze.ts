import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  resolveSnoozePresets as resolveSharedSnoozePresets,
  snoozeForTimeError,
  snoozeWakeLabel,
  type SnoozePreset,
} from "@t3tools/client-runtime/state/thread-settled";

import { formatShortTimestamp, parseTimestampDate } from "../timestampFormat";

export { snoozeWakeLabel, type SnoozePreset };

const DAY_MS = 24 * 60 * 60 * 1_000;
const MINUTE_MS = 60 * 1_000;

export type SnoozeForInputResult =
  | { readonly ok: true; readonly value: Date }
  | { readonly ok: false; readonly error: string };

function padDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

/** Formats a Date for an HTML datetime-local input without losing local time. */
export function formatSnoozeForInput(value: Date): string {
  return [
    `${value.getFullYear()}-${padDatePart(value.getMonth() + 1)}-${padDatePart(value.getDate())}`,
    `${padDatePart(value.getHours())}:${padDatePart(value.getMinutes())}`,
  ].join("T");
}

function matchesLocalParts(
  value: Date,
  parts: readonly [number, number, number, number, number],
): boolean {
  return (
    value.getFullYear() === parts[0] &&
    value.getMonth() === parts[1] - 1 &&
    value.getDate() === parts[2] &&
    value.getHours() === parts[3] &&
    value.getMinutes() === parts[4]
  );
}

/**
 * Parses a browser local wall time. Component round-tripping rejects DST-gap
 * normalization, while nearby timezone offsets let a repeated wall time
 * resolve to its still-future occurrence regardless of the fallback size.
 */
export function parseSnoozeForInput(
  input: string,
  options: { readonly now: Date },
): SnoozeForInputResult {
  const match = /^(\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(input);
  if (!match) return { ok: false, error: "Choose a valid date and time." };
  const parts = match.slice(1).map(Number) as unknown as readonly [
    number,
    number,
    number,
    number,
    number,
  ];
  const initial = new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], 0, 0);
  if (!matchesLocalParts(initial, parts)) {
    return { ok: false, error: "Choose a valid date and time." };
  }

  const initialOffset = initial.getTimezoneOffset();
  const nearbyOffsets = new Set(
    [-2, -1, 0, 1, 2].map((dayDelta) =>
      new Date(initial.getTime() + dayDelta * DAY_MS).getTimezoneOffset(),
    ),
  );
  const candidates = [...nearbyOffsets]
    .map((offset) => new Date(initial.getTime() + (offset - initialOffset) * MINUTE_MS))
    .filter((candidate) => matchesLocalParts(candidate, parts))
    .toSorted((left, right) => left.getTime() - right.getTime());
  const future = candidates.findLast(
    (candidate) => snoozeForTimeError(candidate, options) === null,
  );
  if (future) return { ok: true, value: future };
  return {
    ok: false,
    error: snoozeForTimeError(initial, options) ?? "Choose a valid date and time.",
  };
}

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
