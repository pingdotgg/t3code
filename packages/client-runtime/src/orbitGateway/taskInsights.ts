import { PROVIDER_DISPLAY_NAMES, ProviderDriverKind } from "@t3tools/contracts";
import { DateTime } from "effect";
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
  readonly value: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const NO_VALUES: OrbitTaskInsightsSummary = {
  tasks: null,
  merged: null,
  tokens: null,
  tokensPerMergedPr: null,
  leadTimeMs: null,
  deliveryTimeMs: null,
  deployWaitMs: null,
  prMergeWaitMs: null,
  prFirstPass: null,
  wastedShare: null,
  reviewRounds: null,
};

interface Bucket {
  readonly date: string;
  readonly merged: number;
  readonly values: OrbitTaskInsightsSummary;
}

/**
 * The period's buckets with every missing day or hour added as an empty one, up to the newest
 * bucket and back over the whole period, so a chart runs as one line.
 */
function everyBucket(buckets: ReadonlyArray<Bucket>, period: OrbitTaskInsightsPeriod) {
  const [slots, step] = period === "24h" ? [24, HOUR_MS] : [period === "7d" ? 7 : 30, DAY_MS];
  const byTime = new Map(buckets.map((bucket) => [Date.parse(bucket.date), bucket]));
  const times = [...byTime.keys()];
  if (times.length === 0 || times.some(Number.isNaN)) return buckets;
  const end = Math.max(...times);
  const start = Math.min(...times, end - (slots - 1) * step);
  const label = (time: number) =>
    period === "24h"
      ? `${DateTime.formatIso(DateTime.makeUnsafe(time)).slice(0, 13)}:00:00+00:00`
      : DateTime.formatIso(DateTime.makeUnsafe(time)).slice(0, 10);
  const filled: Bucket[] = [];
  for (let time = start; time <= end; time += step) {
    filled.push(byTime.get(time) ?? { date: label(time), merged: 0, values: NO_VALUES });
  }
  return filled;
}

/**
 * The insight over time, one continuous line over the whole period: merges summed over a trailing
 * window (7 days in 30d, 3 days or hours else); every other number per day, or per hour in 24h.
 * A bucket without a value charts as 0. Tokens per task falls back to weeks when no bucket has it.
 */
export function insightTrend(
  insights: OrbitTaskInsights | null,
  id: InsightId,
): ReadonlyArray<TrendPoint> | null {
  if (insights === null) return null;
  const reported =
    insights.period === "24h"
      ? insights.hourly.map((hour) => ({
          date: hour.hour,
          merged: hour.merged,
          values: hour.values,
        }))
      : insights.daily;
  if (reported.length === 0) return null;
  const buckets = everyBucket(reported, insights.period);
  if (id === "completed") {
    const [step, window] = insights.period === "30d" ? [2, 7] : [1, 3];
    return trailing(buckets, step, window);
  }
  const values = buckets.map((bucket) => rawValue(bucket.values, id));
  if (id === "tokens" && values.every((value) => value === null) && insights.weekly.length > 1) {
    return insights.weekly.map((week) => ({
      date: week.weekStart,
      value: week.tokensPerMergedPr ?? 0,
    }));
  }
  return buckets.map((bucket, index) => ({ date: bucket.date, value: values[index] ?? 0 }));
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

/** Orbit's provider names, by CLI. */
export type InsightProvider = "codex" | "claude" | "gemini";
const PROVIDER_ORDER: ReadonlyArray<InsightProvider> = ["codex", "claude", "gemini"];

/** Orbit breaks insights down by model; the board names the provider behind it. */
function insightProviderOf(model: string): InsightProvider | null {
  const name = model.toLowerCase();
  if (/claude|opus|sonnet|haiku/.test(name)) return "claude";
  if (/gemini/.test(name)) return "gemini";
  if (/codex|gpt|^o\d/.test(name)) return "codex";
  return null;
}

/** Conn's name for the provider, else its CLI name capitalized. */
export function insightProviderName(provider: InsightProvider): string {
  const known =
    PROVIDER_DISPLAY_NAMES[
      ProviderDriverKind.make(provider === "claude" ? "claudeAgent" : provider)
    ];
  return known ?? `${provider.charAt(0).toUpperCase()}${provider.slice(1)}`;
}

/**
 * The insight per provider, from Orbit's model breakdown, in a fixed provider order. Models of one
 * provider combine weighted by their merged tasks. Empty for numbers the breakdown lacks.
 */
export function insightByProvider(
  insights: OrbitTaskInsights | null,
  id: InsightId,
): ReadonlyArray<{ readonly provider: InsightProvider; readonly value: number | null }> {
  const field =
    id === "completed"
      ? "merged"
      : id === "tokens"
        ? "tokensPerMergedPr"
        : id === "delivery"
          ? "leadTimeMs"
          : null;
  if (insights === null || field === null || insights.byModel.length === 0) return [];
  return PROVIDER_ORDER.flatMap((provider) => {
    const rows = insights.byModel.filter((row) => insightProviderOf(row.key) === provider);
    if (rows.length === 0) return [];
    if (field === "merged") {
      return [{ provider, value: rows.reduce((sum, row) => sum + (row.merged ?? 0), 0) }];
    }
    const weighted = rows.flatMap((row) =>
      row[field] === null || !row.merged ? [] : [{ value: row[field]!, weight: row.merged }],
    );
    const weight = weighted.reduce((sum, entry) => sum + entry.weight, 0);
    return [
      {
        provider,
        value:
          weight === 0
            ? null
            : weighted.reduce((sum, entry) => sum + entry.value * entry.weight, 0) / weight,
      },
    ];
  });
}
