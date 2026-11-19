import { formatTokens } from "@t3tools/shared/usageFormat";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import { formatWorkingDurationLabel } from "../state/models.ts";
import type {
  OrbitTaskInsights,
  OrbitTaskInsightsPeriod,
  OrbitTaskInsightsSummary,
} from "./tasks.ts";

// The board's insight numbers, for the desktop strip and the phone's: Orbit's task insights for the tasks that ended in the period, each
// against the period before. A number Orbit does not report is null and shows a dash.

export type InsightId =
  | "completed"
  | "spent"
  | "tokens"
  | "wasted"
  | "delivery"
  | "firstPass"
  | "mergeWait"
  | "reviewRounds";

export interface InsightSpec {
  readonly id: InsightId;
  readonly label: string;
  /** How the change against the period before reads: percent, share points, or the raw difference. */
  readonly unit: "%" | "pts" | "";
  /** Which way is good; a neutral number shows its change in grey. */
  readonly better: "lower" | "higher" | "neutral";
}

// Two rows: output and tokens, then speed and quality.
export const INSIGHTS: ReadonlyArray<InsightSpec> = [
  { id: "completed", label: msg("Tasks completed"), unit: "%", better: "higher" },
  { id: "spent", label: msg("Tokens spent"), unit: "%", better: "neutral" },
  { id: "tokens", label: msg("Tokens per task"), unit: "%", better: "lower" },
  { id: "wasted", label: msg("Wasted tokens"), unit: "pts", better: "lower" },
  { id: "delivery", label: msg("Delivery time"), unit: "%", better: "lower" },
  { id: "firstPass", label: msg("PR first pass"), unit: "pts", better: "higher" },
  { id: "mergeWait", label: msg("Merge wait"), unit: "%", better: "lower" },
  { id: "reviewRounds", label: msg("Review rounds"), unit: "", better: "lower" },
];

export const INSIGHT_PERIODS: ReadonlyArray<OrbitTaskInsightsPeriod> = ["24h", "7d", "30d"];

/** The raw number behind an insight. Shares are 0–1, durations in milliseconds. */
function rawValue(summary: OrbitTaskInsightsSummary, id: InsightId): number | null {
  switch (id) {
    case "completed":
      return summary.merged;
    case "spent":
      return summary.tokens;
    case "tokens":
      return summary.tokensPerMergedPr;
    case "wasted":
      return summary.wastedShare;
    case "delivery":
      // Ready to deployed once Orbit stamps deploys (6041); ready to merged until then.
      return summary.deliveryTimeMs ?? summary.leadTimeMs;
    case "firstPass":
      return summary.prFirstPass;
    case "mergeWait":
      // PR opened to merged (6042). Orbit's `merge_wait_ms` measures from settled subtasks.
      return summary.prMergeWaitMs;
    case "reviewRounds":
      return summary.reviewRounds;
  }
}

/** Short text for a raw value, for the cards, the axis and the legend. */
export function formatInsightValue(
  id: InsightId,
  value: number,
  resolve: MFunctionType = mFallback,
) {
  switch (id) {
    case "completed":
      return String(Math.round(value));
    case "spent":
    case "tokens":
      return formatTokens(value);
    case "delivery":
    case "mergeWait":
      return formatWorkingDurationLabel(value, resolve);
    case "reviewRounds":
      return value.toFixed(1);
    case "wasted":
    case "firstPass":
      return `${Math.round(value * 100)}%`;
  }
}

export interface InsightResult {
  readonly value: number | null;
  /** Against the period before, in the insight's unit; null when either period has no value. */
  readonly change: number | null;
}

function changeOf(spec: InsightSpec, now: number | null, before: number | null): number | null {
  if (now === null || before === null) return null;
  if (spec.unit === "pts") return Math.round((now - before) * 100);
  if (spec.unit === "") return Math.round((now - before) * 10) / 10;
  return before === 0 ? null : Math.round(((now - before) / before) * 100);
}

/** Every insight's number and change. A failed or missing read gives dashes, never zeros. */
export function insightResults(
  insights: OrbitTaskInsights | null,
): Readonly<Record<InsightId, InsightResult>> {
  return Object.fromEntries(
    INSIGHTS.map((spec) => {
      const now = insights ? rawValue(insights.current, spec.id) : null;
      const before = insights ? rawValue(insights.previous, spec.id) : null;
      return [spec.id, { value: now, change: changeOf(spec, now, before) }];
    }),
  ) as Record<InsightId, InsightResult>;
}

/** Whether a change is good, bad, or neither (no change, or a neutral number). */
export function insightChangeTone(
  spec: InsightSpec,
  change: number | null,
): "good" | "bad" | "neutral" {
  if (change === null || change === 0 || spec.better === "neutral") return "neutral";
  return change < 0 === (spec.better === "lower") ? "good" : "bad";
}

export interface TrendPoint {
  /** The last day the point covers, `YYYY-MM-DD`, or the start of its last hour (ISO) in the 24-hour view. */
  readonly date: string;
  readonly value: number | null;
}

/**
 * The insight over time, where Orbit reports a series: merges summed over a trailing window of
 * days (7 days in the 30-day view, 3 in the 7-day view) or of hours (3 in the 24-hour view), and tokens per task by week. Null for
 * every other number until Orbit reports its history.
 */
export function insightTrend(
  insights: OrbitTaskInsights | null,
  id: InsightId,
): ReadonlyArray<TrendPoint> | null {
  if (insights === null) return null;
  if (id === "completed" && insights.period === "24h") {
    return insights.hourly.length > 1
      ? trailing(
          insights.hourly.map((hour) => ({ date: hour.hour, merged: hour.merged })),
          1,
          3,
        )
      : null;
  }
  if (id === "completed" && insights.daily.length > 1) {
    const [step, window] = insights.period === "30d" ? [2, 7] : [1, 3];
    return trailing(insights.daily, step, window);
  }
  if (id === "tokens" && insights.weekly.length > 1) {
    return insights.weekly.map((week) => ({
      date: week.weekStart,
      value: week.tokensPerMergedPr,
    }));
  }
  return null;
}

/** Merges summed over a trailing window of buckets, one point every `step` buckets, ending at the newest. */
function trailing(
  buckets: ReadonlyArray<{ readonly date: string; readonly merged: number }>,
  step: number,
  window: number,
): ReadonlyArray<TrendPoint> {
  const points: TrendPoint[] = [];
  for (let end = buckets.length - 1; end >= 0; end -= step) {
    const span = buckets.slice(Math.max(0, end - window + 1), end + 1);
    points.unshift({ date: buckets[end]!.date, value: span.reduce((sum, b) => sum + b.merged, 0) });
  }
  return points;
}
