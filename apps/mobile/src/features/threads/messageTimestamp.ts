// Formatters pin the default zone when built, and Hermes keeps Date's local offset until a cold
// start (react/react-native#59131), so formatting and day checks follow the zone Intl reports.
function buildFormatters(timeZone: string) {
  return {
    timeZone,
    time: new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone }),
    date: new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric", timeZone }),
    dateWithYear: new Intl.DateTimeFormat(undefined, {
      month: "numeric",
      day: "numeric",
      year: "numeric",
      timeZone,
    }),
    year: new Intl.DateTimeFormat(undefined, { year: "numeric", timeZone }),
  };
}

// Reading the zone builds a formatter (tens of µs), so feed rows share one read per second.
const ZONE_RECHECK_MS = 1_000;
let formatters: ReturnType<typeof buildFormatters> | null = null;
let zoneCheckedAt = 0;
function currentFormatters() {
  const now = Date.now();
  if (formatters && Math.abs(now - zoneCheckedAt) < ZONE_RECHECK_MS) return formatters;
  zoneCheckedAt = now;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!formatters || formatters.timeZone !== timeZone) formatters = buildFormatters(timeZone);
  return formatters;
}

/** Time only for today's messages; older ones lead with the day and month. */
export function formatMessageTimestamp(
  input: string,
  nowMs: number = Date.now(),
  timeFormatter?: Intl.DateTimeFormat,
): string {
  const timestamp = Date.parse(input);
  if (Number.isNaN(timestamp)) return "";
  const f = currentFormatters();
  const time = (timeFormatter ?? f.time).format(timestamp);
  const dateWithYear = f.dateWithYear.format(timestamp);
  if (dateWithYear === f.dateWithYear.format(nowMs)) return time;
  const sameYear = f.year.format(timestamp) === f.year.format(nowMs);
  return `${sameYear ? f.date.format(timestamp) : dateWithYear} ${time}`;
}

/** `is24Hour` overrides the locale's hour cycle with the system clock preference when known. */
export function createMessageTimeFormatter(is24Hour: boolean | undefined, locale?: string) {
  let cached: { timeZone: string; formatter: Intl.DateTimeFormat } | null = null;
  return (input: string, nowMs?: number): string => {
    const { timeZone } = currentFormatters();
    if (cached?.timeZone !== timeZone) {
      cached = {
        timeZone,
        formatter: new Intl.DateTimeFormat(locale, {
          hour: "numeric",
          minute: "2-digit",
          timeZone,
          ...(is24Hour === undefined ? {} : { hourCycle: is24Hour ? "h23" : "h12" }),
        }),
      };
    }
    return formatMessageTimestamp(input, nowMs, cached.formatter);
  };
}
