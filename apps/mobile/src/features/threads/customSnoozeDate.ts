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

/** Date and time segment labels in the app language, not the device's. */
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
