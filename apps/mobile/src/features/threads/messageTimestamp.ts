const TIME_FORMATTER = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric" });
const DATE_WITH_YEAR_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "numeric",
  day: "numeric",
  year: "numeric",
});

/** Time only for today's messages; older ones lead with the day and month. */
export function formatMessageTimestamp(
  input: string,
  nowMs: number = Date.now(),
  timeFormatter: Intl.DateTimeFormat = TIME_FORMATTER,
): string {
  const timestamp = Date.parse(input);
  if (Number.isNaN(timestamp)) return "";
  const date = new Date(timestamp);
  const now = new Date(nowMs);
  const time = timeFormatter.format(date);
  if (date.toDateString() === now.toDateString()) return time;
  const sameYear = date.getFullYear() === now.getFullYear();
  return `${(sameYear ? DATE_FORMATTER : DATE_WITH_YEAR_FORMATTER).format(date)} ${time}`;
}

/** `is24Hour` overrides the locale's hour cycle with the system clock preference when known. */
export function createMessageTimeFormatter(is24Hour: boolean | undefined, locale?: string) {
  const timeFormatter = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    ...(is24Hour === undefined ? {} : { hourCycle: is24Hour ? "h23" : "h12" }),
  });
  return (input: string, nowMs?: number): string =>
    formatMessageTimestamp(input, nowMs, timeFormatter);
}
