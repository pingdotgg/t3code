import {
  resolveSnoozeWallTime,
  type SnoozeWallTime,
  type SnoozeWallTimeResult,
} from "@t3tools/client-runtime/state/thread-settled";

export type AndroidSnoozePicker = "date" | "time";

export function resolveAndroidPickerValue(value: SnoozeWallTime, part: AndroidSnoozePicker): Date {
  if (part === "time") return new Date(2000, 0, 15, value.hour, value.minute);
  return new Date(Date.UTC(value.year, value.month - 1, value.day));
}

export function resolveAndroidMinimumDate(now: Date): Date {
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

export function mergeAndroidPickerValue(
  current: SnoozeWallTime,
  selected: Date,
  part: AndroidSnoozePicker,
): SnoozeWallTime {
  if (part === "date") {
    // Material DatePicker returns the chosen calendar day as UTC midnight.
    return {
      ...current,
      year: selected.getUTCFullYear(),
      month: selected.getUTCMonth() + 1,
      day: selected.getUTCDate(),
    };
  }

  return { ...current, hour: selected.getHours(), minute: selected.getMinutes() };
}

export function resolveAndroidSnoozeValue(
  value: SnoozeWallTime,
  options: { readonly now: Date },
): SnoozeWallTimeResult {
  return resolveSnoozeWallTime(value, options);
}

export function formatAndroidSnoozeDate(value: SnoozeWallTime): string {
  return new Date(Date.UTC(value.year, value.month - 1, value.day)).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function formatAndroidSnoozeTime(value: SnoozeWallTime): string {
  return new Date(Date.UTC(2000, 0, 15, value.hour, value.minute)).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
}
