const UNITS = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
] as const;
const AGO = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" });

/** How long ago an ISO time was, in Orca's short form, or "now" inside a minute. */
export function ago(iso: string): string {
  const elapsed = Date.now() - new Date(iso).getTime();
  for (const [unit, size] of UNITS) {
    if (elapsed >= size) return AGO.format(-Math.floor(elapsed / size), unit);
  }
  return "now";
}
