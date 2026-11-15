import * as DateTime from "effect/DateTime";

export type SharePeriod = "day" | "week" | "month" | "total";

export interface ShareLimits {
  readonly maxRequests: number | null;
  readonly maxTokens: number | null;
  readonly period: SharePeriod;
  readonly maxConcurrent: number;
}

export interface ShareUsage {
  /** When the current period began (ISO). Counters below belong to it. */
  readonly periodStart: string;
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Start of the period containing `now`, in UTC: midnight, Monday, or the 1st. */
export function periodStart(period: SharePeriod, now: DateTime.Utc): string {
  if (period === "total") return DateTime.formatIso(DateTime.makeUnsafe(0));
  const part = period === "day" ? "day" : period === "week" ? "week" : "month";
  return DateTime.formatIso(DateTime.startOf(now, part, { weekStartsOn: 1 }));
}

/** Usage counted from the current period; a new period starts from zero. */
export function currentUsage(
  usage: ShareUsage,
  period: SharePeriod,
  now: DateTime.Utc,
): ShareUsage {
  const start = periodStart(period, now);
  return usage.periodStart === start
    ? usage
    : { periodStart: start, requests: 0, inputTokens: 0, outputTokens: 0 };
}

export type AdmitResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "requests" | "tokens" | "concurrency";
      readonly message: string;
    };

/**
 * Whether one more request may start. Requests already running count against the request
 * budget, so parallel requests cannot all slip past the last remaining slot.
 */
export function admitRequest(input: {
  readonly limits: ShareLimits;
  readonly usage: ShareUsage;
  readonly inFlight: number;
}): AdmitResult {
  const { limits, usage, inFlight } = input;
  if (inFlight >= limits.maxConcurrent) {
    return {
      ok: false,
      reason: "concurrency",
      message: `This shared connection allows ${limits.maxConcurrent} request${limits.maxConcurrent === 1 ? "" : "s"} at a time. Try again in a moment.`,
    };
  }
  if (limits.maxRequests !== null && usage.requests + inFlight >= limits.maxRequests) {
    return {
      ok: false,
      reason: "requests",
      message: `The owner's request limit for this shared connection is used up for this ${limits.period === "total" ? "share" : limits.period}.`,
    };
  }
  const tokens = usage.inputTokens + usage.outputTokens;
  if (limits.maxTokens !== null && tokens >= limits.maxTokens) {
    return {
      ok: false,
      reason: "tokens",
      message: `The owner's token limit for this shared connection is used up for this ${limits.period === "total" ? "share" : limits.period}.`,
    };
  }
  return { ok: true };
}

/** How much of the tighter budget is used, 0–1, or null without limits. */
export function usedFraction(limits: ShareLimits, usage: ShareUsage): number | null {
  const fractions = [
    limits.maxRequests === null ? null : usage.requests / limits.maxRequests,
    limits.maxTokens === null ? null : (usage.inputTokens + usage.outputTokens) / limits.maxTokens,
  ].filter((value): value is number => value !== null);
  return fractions.length === 0 ? null : Math.min(1, Math.max(...fractions));
}
