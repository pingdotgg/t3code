import type { UsageProviderKind } from "@t3tools/contracts";

import type { DailyTotals } from "./usageMerge.ts";

export type UsageChartMetric = "tokens" | "cost";

export const USAGE_CHART_VIEW_WIDTH = 960;
export const USAGE_CHART_VIEW_HEIGHT = 260;
export const USAGE_CHART_PLOT_TOP = 8;
export const USAGE_CHART_TICK_COUNT = 4;

export interface UsageChartDayColumn {
  readonly bands: readonly {
    readonly provider: UsageProviderKind;
    readonly value: number;
  }[];
  readonly total: number;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

interface CurveSegment {
  readonly from: Point;
  readonly c1: Point;
  readonly c2: Point;
  readonly to: Point;
}

export interface UsageChartPath {
  readonly provider: UsageProviderKind;
  readonly total: number;
  readonly area: string;
  readonly line: string;
}

export type UsageChartLayer =
  | {
      readonly kind: "fill";
      readonly provider: UsageProviderKind;
      readonly path: string;
      readonly opacity: 0.12;
    }
  | {
      readonly kind: "stroke";
      readonly provider: UsageProviderKind;
      readonly path: string;
      readonly width: 2;
    };

export interface UsageChartGeometry {
  readonly columns: readonly UsageChartDayColumn[];
  /** Heavier fills first, followed by every stroke so neither line is covered. */
  readonly layers: readonly UsageChartLayer[];
  readonly ticks: readonly number[];
  readonly stepX: number;
  readonly toY: (value: number) => number;
}

interface BuildUsageChartGeometryOptions {
  readonly days: readonly string[];
  readonly daily: readonly DailyTotals[];
  readonly metric: UsageChartMetric;
  readonly providers: readonly UsageProviderKind[];
  readonly width: number;
  readonly height: number;
  readonly plotTop: number;
  readonly tickCount: number;
}

function valueFor(
  daily: DailyTotals | undefined,
  provider: UsageProviderKind,
  metric: UsageChartMetric,
): number {
  const entry = daily?.byProvider.get(provider);
  if (entry === undefined) return 0;
  return metric === "tokens" ? entry.totalTokens : entry.costUsd;
}

/** Shape-preserving Fritsch-Carlson tangents for spiky, non-negative data. */
function monotoneTangents(points: readonly Point[]): readonly number[] {
  const count = points.length;
  if (count < 2) return [0];

  const slopes: number[] = [];
  for (let index = 0; index < count - 1; index += 1) {
    const dx = (points[index + 1]?.x ?? 0) - (points[index]?.x ?? 0);
    const dy = (points[index + 1]?.y ?? 0) - (points[index]?.y ?? 0);
    slopes.push(dx === 0 ? 0 : dy / dx);
  }

  const tangents: number[] = Array.from({ length: count }, () => 0);
  tangents[0] = slopes[0] ?? 0;
  tangents[count - 1] = slopes[count - 2] ?? 0;
  for (let index = 1; index < count - 1; index += 1) {
    const previous = slopes[index - 1] ?? 0;
    const next = slopes[index] ?? 0;
    tangents[index] = previous * next <= 0 ? 0 : (previous + next) / 2;
  }

  for (let index = 0; index < count - 1; index += 1) {
    const slope = slopes[index] ?? 0;
    if (slope === 0) {
      tangents[index] = 0;
      tangents[index + 1] = 0;
      continue;
    }
    const a = (tangents[index] ?? 0) / slope;
    const b = (tangents[index + 1] ?? 0) / slope;
    const magnitude = a * a + b * b;
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      tangents[index] = scale * a * slope;
      tangents[index + 1] = scale * b * slope;
    }
  }

  return tangents;
}

function smoothCurve(points: readonly Point[]): readonly CurveSegment[] {
  if (points.length < 2) return [];
  const tangents = monotoneTangents(points);
  const segments: CurveSegment[] = [];

  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    if (from === undefined || to === undefined) continue;
    const dx = to.x - from.x;
    segments.push({
      from,
      c1: { x: from.x + dx / 3, y: from.y + ((tangents[index] ?? 0) * dx) / 3 },
      c2: { x: to.x - dx / 3, y: to.y - ((tangents[index + 1] ?? 0) * dx) / 3 },
      to,
    });
  }
  return segments;
}

function curvePath(segments: readonly CurveSegment[]): string {
  const first = segments[0];
  if (first === undefined) return "";
  let path = `M${first.from.x.toFixed(2)},${first.from.y.toFixed(2)}`;
  for (const segment of segments) {
    path += ` C${segment.c1.x.toFixed(2)},${segment.c1.y.toFixed(2)} ${segment.c2.x.toFixed(2)},${segment.c2.y.toFixed(2)} ${segment.to.x.toFixed(2)},${segment.to.y.toFixed(2)}`;
  }
  return path;
}

/** Builds a readable 1/2/5 x 10^n scale at or above the peak. */
export function niceUsageChartScale(
  peak: number,
  count: number,
): { max: number; ticks: readonly number[] } {
  if (peak <= 0) return { max: 0, ticks: [0] };

  const rawStep = peak / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;
  const max = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 1e-6; value += step) ticks.push(value);
  return { max, ticks };
}

/** Builds absolute provider values from a shared zero baseline. */
export function buildUsageChartColumns(
  days: readonly string[],
  daily: readonly DailyTotals[],
  metric: UsageChartMetric,
  providers: readonly UsageProviderKind[],
): readonly UsageChartDayColumn[] {
  const byDay = new Map(daily.map((entry) => [entry.day, entry]));
  return days.map((day) => {
    const entry = byDay.get(day);
    const bands = providers.map((provider) => ({
      provider,
      value: valueFor(entry, provider, metric),
    }));
    return { bands, total: bands.reduce((sum, band) => sum + band.value, 0) };
  });
}

/** Shared web/mobile path builder for the layered provider usage chart. */
export function buildUsageChartGeometry({
  days,
  daily,
  metric,
  providers,
  width,
  height,
  plotTop,
  tickCount,
}: BuildUsageChartGeometryOptions): UsageChartGeometry {
  const columns = buildUsageChartColumns(days, daily, metric, providers);
  const peak = columns.reduce(
    (max, column) => column.bands.reduce((inner, band) => Math.max(inner, band.value), max),
    0,
  );
  const { max, ticks } = niceUsageChartScale(peak, tickCount);
  const stepX = days.length <= 1 ? 0 : width / (days.length - 1);
  const toY = (value: number) => (max === 0 ? height : height - (value / max) * (height - plotTop));

  const paths = providers.map((provider, providerIndex) => {
    const points = columns.map((column, dayIndex) => ({
      x: dayIndex * stepX,
      y: toY(column.bands[providerIndex]?.value ?? 0),
    }));
    const onlyPoint = points[0];
    const line =
      points.length === 1 && onlyPoint !== undefined
        ? `M0.00,${onlyPoint.y.toFixed(2)} L${width.toFixed(2)},${onlyPoint.y.toFixed(2)}`
        : curvePath(smoothCurve(points));
    return {
      provider,
      total: columns.reduce((sum, column) => sum + (column.bands[providerIndex]?.value ?? 0), 0),
      area: line === "" ? "" : `${line} L${width},${height} L0,${height} Z`,
      line,
    };
  });

  const ordered = paths.filter((path) => path.line !== "").sort((a, b) => b.total - a.total);
  const layers: UsageChartLayer[] = [
    ...ordered.map(({ provider, area }) => ({
      kind: "fill" as const,
      provider,
      path: area,
      opacity: 0.12 as const,
    })),
    ...ordered.map(({ provider, line }) => ({
      kind: "stroke" as const,
      provider,
      path: line,
      width: 2 as const,
    })),
  ];
  return { columns, layers, ticks, stepX, toY };
}
