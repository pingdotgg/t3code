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
    title: "Custom snooze",
    modeLabel: "Snooze mode",
    untilLabel: "Snooze until",
    submit: "Snooze",
    cancelLabel: "Cancel custom snooze",
  },
  mute: {
    title: "Mute notifications",
    modeLabel: "Mute mode",
    untilLabel: "Mute until",
    submit: "Mute",
    cancelLabel: "Cancel muting",
  },
} as const;
export type CustomTimeSheetPurpose = keyof typeof CUSTOM_TIME_SHEET_COPY;
