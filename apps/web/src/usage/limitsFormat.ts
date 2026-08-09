/**
 * Display formatting for account rate limits.
 *
 * @module limitsFormat
 */

const TIME = new Intl.DateTimeFormat("en-US", {
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
});
const DATE_TIME = new Intl.DateTimeFormat("en-US", {
  month: "numeric",
  day: "numeric",
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * When a window resets: `16:00` inside 24 hours, `8/12 16:00` beyond.
 * Null for windows with no reset clock yet, "now" once the moment has passed
 * (the provider refreshes lazily, so a stale timestamp lingers briefly).
 */
export function formatResetAt(resetsAt: string | null, nowMs: number): string | null {
  if (resetsAt === null) return null;
  const at = Date.parse(resetsAt);
  if (Number.isNaN(at)) return null;
  if (at <= nowMs) return "now";
  if (at - nowMs < 24 * 60 * 60 * 1000) return TIME.format(at);
  return DATE_TIME.format(at).replace(", ", " ");
}

/** Age of a snapshot: `just now`, `5m ago`, `6h ago`, `3d ago`. */
export function formatAgo(asOf: string, nowMs: number): string {
  const at = Date.parse(asOf);
  if (Number.isNaN(at)) return "";
  const minutes = Math.floor(Math.max(0, nowMs - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
