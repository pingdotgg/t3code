import { msg } from "gt-react-native";

/** Compose calendars exchange calendar days at UTC midnight, not local instants. */
export function snoozeDateToPickerDate(date: Date): string {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())).toISOString();
}

export function applySnoozePickerDate(date: Date, selected: Date): Date {
  const next = new Date(date);
  next.setFullYear(selected.getUTCFullYear(), selected.getUTCMonth(), selected.getUTCDate());
  return next;
}

export function applySnoozePickerTime(date: Date, selected: Date): Date {
  const next = new Date(date);
  next.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
  return next;
}

/** Muting picks its end time with the same sheet as snoozing. */
export const CUSTOM_TIME_SHEET_COPY = {
  snooze: {
    title: msg("Custom snooze"),
    modeLabel: msg("Snooze mode"),
    untilLabel: msg("Snooze until"),
    submit: msg("Snooze", { $context: "verb, confirm button" }),
    cancelLabel: msg("Cancel custom snooze"),
  },
  mute: {
    title: msg("Mute notifications"),
    modeLabel: msg("Mute mode"),
    untilLabel: msg("Mute until"),
    submit: msg("Mute", { $context: "verb, confirm button" }),
    cancelLabel: msg("Cancel muting"),
  },
} as const;
export type CustomTimeSheetPurpose = keyof typeof CUSTOM_TIME_SHEET_COPY;

/** Format the segment labels without changing the device's hour-cycle setting. */
export function snoozePickerLabels(date: Date, locale: string, is24Hour: boolean) {
  return {
    date: date.toLocaleDateString(locale, { month: "short", day: "numeric" }),
    time: date.toLocaleTimeString(locale, {
      hour: "numeric",
      minute: "2-digit",
      hourCycle: is24Hour ? "h23" : "h12",
    }),
  };
}
