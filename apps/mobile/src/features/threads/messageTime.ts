import { formatMessageTimestamp } from "./messageTimestamp";

export function createMessageTimeFormatter(is24Hour: boolean | undefined, locale?: string) {
  const timeFormatter = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    ...(is24Hour === undefined ? {} : { hourCycle: is24Hour ? "h23" : "h12" }),
  });
  return (input: string, nowMs?: number): string =>
    formatMessageTimestamp(input, nowMs, timeFormatter);
}
