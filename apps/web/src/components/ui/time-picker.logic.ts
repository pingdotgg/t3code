export interface ParsedTime {
  readonly hours: number;
  readonly minutes: number;
}

export type TimePeriod = "am" | "pm";

export interface MinuteOption {
  readonly minute: number;
  readonly offStep: boolean;
}

export function padTimePart(value: number): string {
  return String(value).padStart(2, "0");
}

export function parseTimeValue(value: string): ParsedTime | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return { hours, minutes };
}

export function formatTimeValue(hours: number, minutes: number): string {
  const clampedHours = ((hours % 24) + 24) % 24;
  const clampedMinutes = ((minutes % 60) + 60) % 60;
  return `${padTimePart(clampedHours)}:${padTimePart(clampedMinutes)}`;
}

export function to12Hour(hours24: number): {
  readonly hour12: number;
  readonly period: TimePeriod;
} {
  const period: TimePeriod = hours24 >= 12 ? "pm" : "am";
  const hour12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return { hour12, period };
}

export function to24Hour(hour12: number, period: TimePeriod): number {
  const normalized = ((((hour12 - 1) % 12) + 12) % 12) + 1;
  if (period === "am") return normalized === 12 ? 0 : normalized;
  return normalized === 12 ? 12 : normalized + 12;
}

export function buildMinuteOptions(
  currentMinute: number,
  step: number,
): ReadonlyArray<MinuteOption> {
  const safeStep = Math.max(1, Math.min(30, Math.round(step)));
  const options: Array<MinuteOption> = [];
  for (let minute = 0; minute < 60; minute += safeStep) {
    options.push({ minute, offStep: false });
  }
  if (currentMinute >= 0 && currentMinute <= 59 && currentMinute % safeStep !== 0) {
    options.push({ minute: currentMinute, offStep: true });
    options.sort((a, b) => a.minute - b.minute);
  }
  return options;
}

export function stepHour(hours24: number, delta: number, hour12: boolean): number {
  if (!hour12) {
    return (((hours24 + delta) % 24) + 24) % 24;
  }
  const { hour12: current, period } = to12Hour(hours24);
  const next12 = ((((current - 1 + delta) % 12) + 12) % 12) + 1;
  return to24Hour(next12, period);
}

export function stepMinute(minutes: number, delta: number): number {
  return (((minutes + delta) % 60) + 60) % 60;
}

export function applyHourDigit(
  buffer: string,
  digit: string,
  hour12: boolean,
  period: TimePeriod,
): { readonly nextBuffer: string; readonly nextHour24: number | null; readonly advance: boolean } {
  const raw = buffer + digit;
  const numeric = Number(raw);

  if (hour12) {
    if (buffer === "") {
      if (digit === "0") {
        return { nextBuffer: "0", nextHour24: null, advance: false };
      }
      if (digit === "1") {
        return { nextBuffer: "1", nextHour24: to24Hour(1, period), advance: false };
      }
      return { nextBuffer: "", nextHour24: to24Hour(numeric, period), advance: true };
    }
    if (numeric >= 1 && numeric <= 12) {
      return { nextBuffer: "", nextHour24: to24Hour(numeric, period), advance: true };
    }
    const single = Number(digit);
    if (single >= 1 && single <= 9) {
      return {
        nextBuffer: digit === "1" ? "1" : "",
        nextHour24: to24Hour(single, period),
        advance: digit !== "1",
      };
    }
    return { nextBuffer: "", nextHour24: null, advance: false };
  }

  // 24-hour mode
  if (buffer === "") {
    if (numeric <= 2) {
      return { nextBuffer: digit, nextHour24: numeric, advance: false };
    }
    return { nextBuffer: "", nextHour24: numeric, advance: true };
  }
  if (numeric <= 23) {
    return { nextBuffer: "", nextHour24: numeric, advance: true };
  }
  const single = Number(digit);
  return {
    nextBuffer: single <= 2 ? digit : "",
    nextHour24: single,
    advance: single > 2,
  };
}

export function applyMinuteDigit(
  buffer: string,
  digit: string,
): { readonly nextBuffer: string; readonly nextMinute: number; readonly advance: boolean } {
  const raw = buffer + digit;
  const numeric = Number(raw);

  if (buffer === "") {
    if (numeric <= 5) {
      return { nextBuffer: digit, nextMinute: numeric, advance: false };
    }
    return { nextBuffer: "", nextMinute: numeric, advance: true };
  }
  if (numeric <= 59) {
    return { nextBuffer: "", nextMinute: numeric, advance: true };
  }
  const single = Number(digit);
  return {
    nextBuffer: single <= 5 ? digit : "",
    nextMinute: single,
    advance: single > 5,
  };
}
