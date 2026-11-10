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

let formatters: ReturnType<typeof buildFormatters> | null = null;
function currentFormatters() {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (formatters?.timeZone !== timeZone) formatters = buildFormatters(timeZone);
  return formatters;
}

/** Time only for today's messages; older ones lead with the day and month. */
export function formatMessageTimestamp(input: string, nowMs: number = Date.now()): string {
  const timestamp = Date.parse(input);
  if (Number.isNaN(timestamp)) return "";
  const f = currentFormatters();
  const time = f.time.format(timestamp);
  const dateWithYear = f.dateWithYear.format(timestamp);
  if (dateWithYear === f.dateWithYear.format(nowMs)) return time;
  const sameYear = f.year.format(timestamp) === f.year.format(nowMs);
  return `${sameYear ? f.date.format(timestamp) : dateWithYear} ${time}`;
}
