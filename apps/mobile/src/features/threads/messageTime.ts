export function createMessageTimeFormatter(is24Hour: boolean | undefined, locale?: string) {
  const formatter = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    ...(is24Hour === undefined ? {} : { hourCycle: is24Hour ? "h23" : "h12" }),
  });
  return (input: string): string => {
    const timestamp = Date.parse(input);
    return Number.isNaN(timestamp) ? "" : formatter.format(timestamp);
  };
}
