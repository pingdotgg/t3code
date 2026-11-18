// Formatters pin the default zone when built, and Hermes keeps Date's local offset until a cold
// start (react/react-native#59131), so formatting and day checks follow the zone Intl reports.
function buildFormatters(timeZone: string, dateLocale: string | undefined, is24Hour?: boolean) {
  return {
    timeZone,
    time: new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      timeZone,
      ...(is24Hour === undefined ? {} : { hourCycle: is24Hour ? "h23" : "h12" }),
    }),
    date: new Intl.DateTimeFormat(dateLocale, { month: "numeric", day: "numeric", timeZone }),
    dateWithYear: new Intl.DateTimeFormat(dateLocale, {
      month: "numeric",
      day: "numeric",
      year: "numeric",
      timeZone,
    }),
    year: new Intl.DateTimeFormat(dateLocale, { year: "numeric", timeZone }),
  };
}

// Reading the zone builds a formatter (tens of µs), so feed rows share one read per second.
const ZONE_RECHECK_MS = 1_000;
let timeZone: string | undefined;
let zoneCheckedAt = 0;
function currentTimeZone(): string {
  const now = Date.now();
  if (timeZone !== undefined && Math.abs(now - zoneCheckedAt) < ZONE_RECHECK_MS) return timeZone;
  zoneCheckedAt = now;
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timeZone;
}

/**
 * Time uses the device locale and clock preference. Older messages also show the date in `dateLocale`.
 */
export function createMessageTimeFormatter(is24Hour: boolean | undefined, dateLocale?: string) {
  let f: ReturnType<typeof buildFormatters> | null = null;
  return (input: string, nowMs: number = Date.now()): string => {
    const timestamp = Date.parse(input);
    if (Number.isNaN(timestamp)) return "";
    const zone = currentTimeZone();
    if (f?.timeZone !== zone) f = buildFormatters(zone, dateLocale, is24Hour);
    const time = f.time.format(timestamp);
    const dateWithYear = f.dateWithYear.format(timestamp);
    if (dateWithYear === f.dateWithYear.format(nowMs)) return time;
    const sameYear = f.year.format(timestamp) === f.year.format(nowMs);
    return `${sameYear ? f.date.format(timestamp) : dateWithYear} ${time}`;
  };
}
