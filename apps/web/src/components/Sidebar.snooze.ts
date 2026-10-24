import type { SnoozeFavorite, TimestampFormat } from "@t3tools/contracts/settings";
import {
  resolveSnoozePresetsWithFavorites,
  snoozeWakeLabel,
  type SnoozePreset,
} from "@t3tools/client-runtime/state/thread-settled";

import { formatShortTimestamp, parseTimestampDate } from "../timestampFormat";

export { snoozeWakeLabel, type SnoozePreset };

function timeOfDayLabel(date: Date, timestampFormat: TimestampFormat): string {
  return formatShortTimestamp(date.toISOString(), timestampFormat);
}

/** The built-in presets, then the user's saved custom durations. */
export function resolveSnoozePresets(
  now: Date,
  timestampFormat: TimestampFormat,
  favorites: ReadonlyArray<SnoozeFavorite> = [],
): ReadonlyArray<SnoozePreset> {
  return resolveSnoozePresetsWithFavorites(favorites, now).map((preset) => {
    const wake = parseTimestampDate(preset.snoozedUntil);
    if (wake === null) return preset;
    const time = timeOfDayLabel(wake, timestampFormat);
    return {
      ...preset,
      // A wake on another day names its weekday, so a saved duration such
      // as "26 hours" does not read as earlier than "Tomorrow".
      whenLabel:
        preset.id === "next-week" ||
        (preset.id.startsWith("favorite:") && wake.toDateString() !== now.toDateString())
          ? `${wake.toLocaleDateString(undefined, { weekday: "short" })} ${time}`
          : time,
    };
  });
}
