import { headers } from "next/headers";
import { visitorTimezoneHeader } from "../../src/VisitorTimezone.ts";

function formatTime(
  value: string | number,
  locale: string,
  timeZone: string,
): { iso: string; label: string } {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { iso: "", label: "" };
  }
  return {
    iso: date.toISOString(),
    label: date.toLocaleString(locale, {
      dateStyle: "medium",
      timeStyle: "medium",
      timeZone,
    }),
  };
}

async function visitorFormat(): Promise<{ locale: string; timeZone: string }> {
  const h = await headers();
  const locale = h.get("accept-language")?.split(",")[0]?.split(";")[0]?.trim();
  return {
    locale: locale || "en-US",
    timeZone: h.get(visitorTimezoneHeader()) ?? "UTC",
  };
}

/**
 * Server timestamp. Visitor locale + Cloudflare timezone, unless `cached`
 * (UTC) for prerendered routes that must not read request headers.
 */
export async function LocalTime({
  value,
  cached = false,
  testId,
}: {
  value: string | number;
  cached?: boolean;
  testId?: string;
}) {
  const { locale, timeZone } = cached
    ? { locale: "en-US", timeZone: "UTC" }
    : await visitorFormat();
  const { iso, label } = formatTime(value, locale, timeZone);

  return (
    <time data-testid={testId} dateTime={iso} title={iso}>
      {label}
    </time>
  );
}
