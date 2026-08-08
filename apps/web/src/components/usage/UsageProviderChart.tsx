import type { UsageProviderKind } from "@t3tools/contracts";
import { useCallback, useMemo, useRef, useState } from "react";

import type { DailyTotals } from "../../usage/usageMerge";
import { formatDayShort, formatTokens, formatUsd } from "../../usage/usageFormat";
import { PROVIDER_COLOR, PROVIDER_LABEL, PROVIDER_MARK, PROVIDER_ORDER } from "./usageProviders";

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 260;
const TICK_COUNT = 4;
const PLOT_TOP = 8;

export type UsageChartMetric = "tokens" | "cost";

interface UsageProviderChartProps {
  readonly days: readonly string[];
  readonly daily: readonly DailyTotals[];
  readonly metric: UsageChartMetric;
}

/** One day's per-provider values, shared by the paths and the hover readout. */
export interface DayColumn {
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

function valueFor(
  daily: DailyTotals | undefined,
  provider: UsageProviderKind,
  metric: UsageChartMetric,
): number {
  const entry = daily?.byProvider.get(provider);
  if (entry === undefined) return 0;
  return metric === "tokens" ? entry.totalTokens : entry.costUsd;
}

/**
 * Monotone cubic tangents (Fritsch-Carlson).
 *
 * Plain cubic smoothing overshoots on spiky daily data and would dip the area
 * below zero between points, which reads as negative spend. This variant is
 * shape-preserving, so a smoothed series never leaves the range of its samples.
 */
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

/** One cubic segment of a smoothed boundary. */
interface CurveSegment {
  readonly from: Point;
  readonly c1: Point;
  readonly c2: Point;
  readonly to: Point;
}

/** Smoothed polyline through `points`, as explicit cubic control points. */
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

function curvePath(segments: readonly CurveSegment[], startCommand: "M" | "L"): string {
  const first = segments[0];
  if (first === undefined) return "";
  let path = `${startCommand}${first.from.x.toFixed(2)},${first.from.y.toFixed(2)}`;
  for (const segment of segments) {
    path += ` C${segment.c1.x.toFixed(2)},${segment.c1.y.toFixed(2)} ${segment.c2.x.toFixed(2)},${segment.c2.y.toFixed(2)} ${segment.to.x.toFixed(2)},${segment.to.y.toFixed(2)}`;
  }
  return path;
}

/**
 * Builds a scale whose maximum is a readable 1/2/5 x 10^n step at or above the
 * peak.
 *
 * Rounding the maximum *up* is the point: stopping at the last step below the
 * peak leaves the tallest day drawn past the top of the plot, where it is
 * clipped.
 */
export function niceScale(peak: number, count: number): { max: number; ticks: readonly number[] } {
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

/**
 * Turns the merged daily totals into one column per day.
 *
 * Values are absolute, not cumulative: the series are layered from a shared
 * zero baseline rather than stacked. A stacked chart puts whichever provider is
 * drawn last permanently above the other, which reads as "that one is bigger"
 * even on days where it is not.
 *
 * The chart paths and the hover readout both consume this, so the number under
 * the cursor is by construction the number that was plotted rather than a
 * second derivation that can drift from it.
 */
export function buildDayColumns(
  days: readonly string[],
  byDay: ReadonlyMap<string, DailyTotals>,
  metric: UsageChartMetric,
): readonly DayColumn[] {
  return days.map((day) => {
    const entry = byDay.get(day);
    const bands = PROVIDER_ORDER.map((provider) => ({
      provider,
      value: valueFor(entry, provider, metric),
    }));
    return { bands, total: bands.reduce((sum, band) => sum + band.value, 0) };
  });
}

export function UsageProviderChart({ days, daily, metric }: UsageProviderChartProps) {
  const byDay = useMemo(() => new Map(daily.map((entry) => [entry.day, entry])), [daily]);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);

  const { paths, ticks, stepX, toY, series } = useMemo(() => {
    if (days.length === 0) {
      return {
        paths: [],
        ticks: [0] as readonly number[],
        stepX: 0,
        toY: () => VIEW_HEIGHT,
        series: [] as readonly DayColumn[],
      };
    }

    const columns = buildDayColumns(days, byDay, metric);

    // The scale tops out at the largest single provider-day, not the largest
    // sum: layered series each measure from zero, so a combined peak would
    // leave the plot permanently half empty.
    const peak = columns.reduce(
      (max, column) => column.bands.reduce((inner, band) => Math.max(inner, band.value), max),
      0,
    );
    const { max, ticks: tickValues } = niceScale(peak, TICK_COUNT);
    const step = days.length === 1 ? 0 : VIEW_WIDTH / (days.length - 1);
    // Reserve a sliver above the top gridline so the series stroke, which is
    // drawn at constant screen width, is not shaved off at a peak.
    const toY = (value: number) =>
      max === 0 ? VIEW_HEIGHT : VIEW_HEIGHT - (value / max) * (VIEW_HEIGHT - PLOT_TOP);

    const built = PROVIDER_ORDER.map((provider, providerIndex) => {
      const curve = smoothCurve(
        columns.map((column, dayIndex) => ({
          x: dayIndex * step,
          y: toY(column.bands[providerIndex]?.value ?? 0),
        })),
      );
      const line = curvePath(curve, "M");
      return {
        provider,
        total: columns.reduce((sum, column) => sum + (column.bands[providerIndex]?.value ?? 0), 0),
        area: line === "" ? "" : `${line} L${VIEW_WIDTH},${VIEW_HEIGHT} L0,${VIEW_HEIGHT} Z`,
        line,
      };
    });

    // Paint the heavier series first so the lighter one is never buried under
    // it. The fills are faint enough that the order barely shows, but the
    // strokes are drawn in a second pass regardless, so neither can be hidden.
    const ordered = [...built].sort((a, b) => b.total - a.total);

    return { paths: ordered, ticks: tickValues, stepX: step, toY, series: columns };
  }, [byDay, days, metric]);

  const format = metric === "tokens" ? formatTokens : formatUsd;

  const handleMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const bounds = plotRef.current?.getBoundingClientRect();
      if (bounds === undefined || bounds.width === 0 || days.length === 0) return;
      const fraction = (event.clientX - bounds.left) / bounds.width;
      const index = Math.round(fraction * (days.length - 1));
      setHoverIndex(Math.min(days.length - 1, Math.max(0, index)));
    },
    [days.length],
  );

  const hoveredDay = hoverIndex === null ? undefined : days[hoverIndex];
  const hoveredColumn = hoverIndex === null ? undefined : series[hoverIndex];
  const hoverLeft = days.length <= 1 ? 0 : ((hoverIndex ?? 0) / (days.length - 1)) * 100;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        {/* Axis labels sit outside the plot so they stay aligned to gridlines. */}
        <div className="relative h-56 w-14 shrink-0">
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 -translate-y-1/2 text-[10px] text-muted-foreground tabular-nums"
              style={{ top: `${(toY(tick) / VIEW_HEIGHT) * 100}%` }}
            >
              {tick === 0 ? "0" : format(tick)}
            </span>
          ))}
        </div>

        <div
          ref={plotRef}
          className="relative h-56 flex-1"
          onMouseMove={handleMove}
          onMouseLeave={() => setHoverIndex(null)}
        >
          <svg
            className="h-full w-full"
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`Daily ${metric === "tokens" ? "processed tokens" : "cost"} by provider`}
          >
            {ticks.map((tick) => {
              const y = toY(tick);
              return (
                <line
                  key={tick}
                  x1={0}
                  x2={VIEW_WIDTH}
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  strokeWidth={1}
                  className="text-border"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}

            {/* Fills first, then every stroke, so no series covers another's line. */}
            {paths.map(({ provider, area }) => (
              <path key={provider} d={area} fill={PROVIDER_COLOR[provider]} fillOpacity={0.12} />
            ))}
            {paths.map(({ provider, line }) => (
              <path
                key={provider}
                d={line}
                fill="none"
                stroke={PROVIDER_COLOR[provider]}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {hoverIndex === null ? null : (
              <line
                x1={hoverIndex * stepX}
                x2={hoverIndex * stepX}
                y1={PLOT_TOP}
                y2={VIEW_HEIGHT}
                stroke="currentColor"
                strokeWidth={1}
                className="text-muted-foreground"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>

          {hoveredDay === undefined ? null : (
            <div
              className="pointer-events-none absolute top-0 z-10 min-w-36 border border-border bg-background/95 px-2 py-1.5 text-xs"
              style={{
                left: `${hoverLeft}%`,
                transform: hoverLeft > 60 ? "translateX(-100%)" : "translateX(0)",
              }}
            >
              <div className="mb-1 text-muted-foreground">{formatDayShort(hoveredDay)}</div>
              {PROVIDER_ORDER.map((provider) => {
                const Mark = PROVIDER_MARK[provider];
                return (
                  <div key={provider} className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <Mark className="size-3 shrink-0" aria-hidden />
                      {PROVIDER_LABEL[provider]}
                    </span>
                    <span className="text-foreground tabular-nums">
                      {format(
                        hoveredColumn?.bands.find((band) => band.provider === provider)?.value ?? 0,
                      )}
                    </span>
                  </div>
                );
              })}
              <div className="mt-1 flex items-center justify-between gap-3 border-t border-border pt-1">
                <span className="text-muted-foreground">Total</span>
                <span className="text-foreground tabular-nums">
                  {format(hoveredColumn?.total ?? 0)}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex justify-between pl-16 text-[10px] text-muted-foreground uppercase">
        <span>{days[0] === undefined ? "" : formatDayShort(days[0])}</span>
        <span>
          {days[Math.floor(days.length / 2)] === undefined
            ? ""
            : formatDayShort(days[Math.floor(days.length / 2)] ?? "")}
        </span>
        <span>
          {days[days.length - 1] === undefined ? "" : formatDayShort(days[days.length - 1] ?? "")}
        </span>
      </div>
    </div>
  );
}

export function UsageChartLegend() {
  return (
    <div className="flex items-center gap-4">
      {PROVIDER_ORDER.map((provider) => {
        // The marks carry the same fills as the bands, so they key the chart
        // just as a colour swatch would.
        const Mark = PROVIDER_MARK[provider];
        return (
          <span key={provider} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Mark className="size-3.5 shrink-0" aria-hidden />
            {PROVIDER_LABEL[provider]}
          </span>
        );
      })}
    </div>
  );
}
