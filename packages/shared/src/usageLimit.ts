/**
 * Provider-agnostic helpers for the "usage limit reached" surface.
 *
 * Every value here is derived from structured provider fields (window type,
 * reset timestamp) — never from raw provider error text — so the resulting
 * strings are safe to persist and render verbatim.
 *
 * @module usageLimit
 */

import * as DateTime from "effect/DateTime";

/**
 * Timestamps below this are unambiguously epoch *seconds* rather than
 * milliseconds (1e12 ms is 2001-09-09; 1e12 s is the year 33658).
 */
const EPOCH_SECONDS_CEILING = 1e12;

/**
 * Normalize a provider reset timestamp to epoch milliseconds.
 *
 * Providers are inconsistent: the Claude Agent SDK and the Claude CLI's
 * stderr line report epoch seconds, Codex reports epoch seconds too, and some
 * transports already hand back milliseconds. Returns `undefined` for anything
 * that isn't a usable positive finite number.
 */
export function normalizeUsageLimitResetsAt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value < EPOCH_SECONDS_CEILING ? Math.round(value * 1000) : Math.round(value);
}

/**
 * Human label for a provider window type, e.g. `five_hour` -> `5-hour`.
 *
 * Unknown window types return `null` so callers fall back to generic copy
 * rather than leaking a provider-internal identifier.
 */
export function usageLimitWindowLabel(windowType: string | null | undefined): string | null {
  switch (windowType) {
    case "five_hour":
      return "5-hour";
    case "seven_day":
      return "weekly";
    case "seven_day_opus":
      return "weekly Opus";
    case "seven_day_sonnet":
      return "weekly Sonnet";
    case "overage":
      return "overage";
    default:
      return null;
  }
}

/**
 * Plain-text message stored on the session / turn.
 *
 * Clients that can format timestamps (the web app) prefer rebuilding the copy
 * from `windowType` + `resetsAt`; this is the persisted, locale-independent
 * fallback.
 */
export function buildUsageLimitMessage(input: {
  readonly windowType?: string | null | undefined;
  readonly resetsAt?: number | null | undefined;
}): string {
  const label = usageLimitWindowLabel(input.windowType);
  const headline = label ? `${label} usage limit reached` : "Usage limit reached";
  const resetsAt = normalizeUsageLimitResetsAt(input.resetsAt);
  return resetsAt === undefined
    ? `${headline}.`
    : `${headline}. Resets at ${DateTime.formatIso(DateTime.makeUnsafe(resetsAt))}.`;
}

/**
 * Detect the Claude CLI's stderr usage-limit line.
 *
 * The CLI prints `Claude AI usage limit reached|<epoch seconds>` on stderr
 * when a run is blocked. Only the epoch is extracted — the raw line never
 * reaches user-facing copy.
 */
export function parseUsageLimitStderrLine(
  chunk: string,
): { readonly resetsAt?: number } | undefined {
  if (!chunk.toLowerCase().includes("usage limit reached")) {
    return undefined;
  }
  const epoch = /usage limit reached\s*\|\s*(\d+)/i.exec(chunk)?.[1];
  const resetsAt = epoch === undefined ? undefined : normalizeUsageLimitResetsAt(Number(epoch));
  return resetsAt === undefined ? {} : { resetsAt };
}
