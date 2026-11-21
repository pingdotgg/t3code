import {
  localSnoozeDate,
  localSnoozeTime,
  resolveCustomSnooze,
  type CustomSnoozeInput,
} from "@lathe/client-runtime/state/thread-settled";

/** The wake time a custom snooze sheet submits. The picker only holds whole
    minutes, so while it still shows the thread's current wake minute the exact
    original time is kept: editing only the note must not move the wake or
    restamp when the thread was snoozed. */
export function resolveSheetSnoozedUntil(
  input: CustomSnoozeInput,
  initialSnoozedUntil: string | null | undefined,
  now: Date,
): string | null {
  const wakeAtMs = initialSnoozedUntil == null ? Number.NaN : Date.parse(initialSnoozedUntil);
  if (input.mode === "date" && initialSnoozedUntil != null && Number.isFinite(wakeAtMs)) {
    const wake = new Date(wakeAtMs);
    if (input.date === localSnoozeDate(wake) && input.time === localSnoozeTime(wake)) {
      return wakeAtMs > now.getTime() ? initialSnoozedUntil : null;
    }
  }
  return resolveCustomSnooze(input, now);
}

/** Where the custom snooze picker starts: the current wake time when the
    thread is still snoozed, otherwise an hour from now. */
export function initialCustomSnoozeDate(snoozedUntil: string | null | undefined, now: Date): Date {
  const wakeAtMs = snoozedUntil == null ? Number.NaN : Date.parse(snoozedUntil);
  return Number.isFinite(wakeAtMs) && wakeAtMs > now.getTime()
    ? new Date(wakeAtMs)
    : new Date(now.getTime() + 3_600_000);
}

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
