import { useCallback, useMemo, useRef, useState } from "react";

import type { DailyTotals } from "../../usage/usageMerge";
import { formatDayShort, formatTokens, formatUsd } from "../../usage/usageFormat";
import { PROVIDER_MARK, type UsageSeries } from "./usageProviders";

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 260;
const TICK_COUNT = 4;
const PLOT_TOP = 8;

export type UsageChartMetric = "tokens" | "cost";

interface UsageProviderChartProps {
  readonly days: readonly string[];
  readonly daily: readonly DailyTotals[];
  readonly series: readonly UsageSeries[];
  readonly metric: UsageChartMetric;
}

/** One day's per-series values, shared by the paths and the hover readout. */
export interface DayColumn {
  readonly bands: readonly {
    readonly seriesKey: string;
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
  seriesKey: string,
  metric: UsageChartMetric,
): number {
  const entry = daily?.bySeries.get(seriesKey);
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
 * zero baseline rather than stacked. A stacked chart puts whichever series is
 * drawn last permanently above the others, which reads as "that one is bigger"
 * even on days where it is not.
 *
 * The chart paths and the hover readout both consume this, so the number under
 * the cursor is by construction the number that was plotted rather than a
 * second derivation that can drift from it.
 */
export function buildDayColumns(
  days: readonly string[],
  byDay: ReadonlyMap<string, DailyTotals>,
  seriesKeys: readonly string[],
  metric: UsageChartMetric,
): readonly DayColumn[] {
  return days.map((day) => {
    const entry = byDay.get(day);
    const bands = seriesKeys.map((seriesKey) => ({
      seriesKey,
      value: valueFor(entry, seriesKey, metric),
    }));
    return { bands, total: bands.reduce((sum, band) => sum + band.value, 0) };
  });
}

export function UsageProviderChart({ days, daily, series, metric }: UsageProviderChartProps) {
  const byDay = useMemo(() => new Map(daily.map((entry) => [entry.day, entry])), [daily]);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);

  const { paths, ticks, stepX, toY, columns } = useMemo(() => {
    if (days.length === 0) {
      return {
        paths: [],
        ticks: [0] as readonly number[],
        stepX: 0,
        toY: () => VIEW_HEIGHT,
        columns: [] as readonly DayColumn[],
      };
    }

    const built = buildDayColumns(
      days,
      byDay,
      series.map((entry) => entry.key),
      metric,
    );

    // The scale tops out at the largest single series-day, not the largest
    // sum: layered series each measure from zero, so a combined peak would
    // leave the plot permanently half empty.
    const peak = built.reduce(
      (max, column) => column.bands.reduce((inner, band) => Math.max(inner, band.value), max),
      0,
    );
    const { max, ticks: tickValues } = niceScale(peak, TICK_COUNT);
    const step = days.length === 1 ? 0 : VIEW_WIDTH / (days.length - 1);
    // Reserve a sliver above the top gridline so the series stroke, which is
    // drawn at constant screen width, is not shaved off at a peak.
    const toY = (value: number) =>
      max === 0 ? VIEW_HEIGHT : VIEW_HEIGHT - (value / max) * (VIEW_HEIGHT - PLOT_TOP);

    const seriesPaths = series.map((entry, seriesIndex) => {
      const curve = smoothCurve(
        built.map((column, dayIndex) => ({
          x: dayIndex * step,
          y: toY(column.bands[seriesIndex]?.value ?? 0),
        })),
      );
      const line = curvePath(curve, "M");
      return {
        series: entry,
        total: built.reduce((sum, column) => sum + (column.bands[seriesIndex]?.value ?? 0), 0),
        area: line === "" ? "" : `${line} L${VIEW_WIDTH},${VIEW_HEIGHT} L0,${VIEW_HEIGHT} Z`,
        line,
      };
    });

    // Paint the heavier series first so the lighter ones are never buried
    // under them. The fills are faint enough that the order barely shows, but
    // the strokes are drawn in a second pass regardless, so none can be hidden.
    const ordered = [...seriesPaths].sort((a, b) => b.total - a.total);

    return { paths: ordered, ticks: tickValues, stepX: step, toY, columns: built };
  }, [byDay, days, metric, series]);

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
  const hoveredColumn = hoverIndex === null ? undefined : columns[hoverIndex];
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
            {paths.map(({ series: entry, area }) => (
              <path key={entry.key} d={area} fill={entry.color} fillOpacity={0.12} />
            ))}
            {paths.map(({ series: entry, line }) => (
              <path
                key={entry.key}
                d={line}
                fill="none"
                stroke={entry.color}
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
              {series.map((entry) => (
                <div key={entry.key} className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <SeriesSwatch series={entry} />
                    {entry.label}
                  </span>
                  <span className="text-foreground tabular-nums">
                    {format(
                      hoveredColumn?.bands.find((band) => band.seriesKey === entry.key)?.value ?? 0,
                    )}
                  </span>
                </div>
              ))}
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

/**
 * Series marker: the brand mark alone when the provider has one home (its fill
 * matches the band colour), a colour dot in the series shade when several homes
 * share the mark and the mark alone could not tell them apart.
 */
export function SeriesSwatch({ series }: { readonly series: UsageSeries }) {
  if (series.homeLabel === null) {
    const Mark = PROVIDER_MARK[series.provider];
    return <Mark className="size-3 shrink-0" aria-hidden />;
  }
  return (
    <span
      className="size-2 shrink-0 rounded-full"
      style={{ backgroundColor: series.color }}
      aria-hidden
    />
  );
}

export function UsageChartLegend({ series }: { readonly series: readonly UsageSeries[] }) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      {series.map((entry) => (
        <span key={entry.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <SeriesSwatch series={entry} />
          {entry.label}
        </span>
      ))}
    </div>
  );
}
