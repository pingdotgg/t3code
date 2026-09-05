import type { UsageProviderKind } from "@t3tools/contracts";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { DailyTotals, HourlyTotals } from "@t3tools/shared/usageMerge";

import { cn } from "../../lib/utils";
import {
  formatDayShort,
  formatHourShort,
  formatRelativeHourShort,
  formatTokens,
  formatUsd,
} from "@t3tools/shared/usageFormat";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "./usageProviders";

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 260;
const TICK_COUNT = 4;
const PLOT_TOP = 8;

export type UsageChartMetric = "tokens" | "cost";

interface UsageProviderChartProps {
  /**
   * Present only when the window can zoom (daily resolution). Receives the
   * inclusive day bounds of a completed drag selection.
   */
  readonly onZoomToDays?: (sinceDay: string, untilDay: string) => void;
  /** Restores the preset window on double-click. */
  readonly onResetZoom?: () => void;
  readonly providers: readonly UsageProviderKind[];
  readonly days: readonly string[];
  readonly daily: readonly DailyTotals[];
  readonly hours: readonly string[];
  readonly hourly: readonly HourlyTotals[];
  readonly metric: UsageChartMetric;
  readonly referenceTime: string | undefined;
  readonly resolution: "day" | "hour";
  readonly timeZone: string;
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

/** Gives a one-period daily window enough horizontal span to draw a path. */
export function spanSinglePeriodPoints(points: readonly Point[]): readonly Point[] {
  const only = points.length === 1 ? points[0] : undefined;
  return only === undefined ? points : [only, { ...only, x: VIEW_WIDTH }];
}

/** Selects distinct left, middle, and right labels for the available span. */
export function chartLabelIndices(periodCount: number): readonly number[] {
  if (periodCount <= 0) return [];
  return [...new Set([0, Math.floor(periodCount / 2), periodCount - 1])];
}

function valueFor(
  totals: DailyTotals | HourlyTotals | undefined,
  provider: UsageProviderKind,
  metric: UsageChartMetric,
): number {
  const entry = totals?.byProvider.get(provider);
  if (entry === undefined) return 0;
  return metric === "tokens" ? entry.totalTokens : entry.costUsd;
}

function buildPeriodColumns(
  periods: readonly string[],
  byPeriod: ReadonlyMap<string, DailyTotals | HourlyTotals>,
  metric: UsageChartMetric,
): readonly DayColumn[] {
  return periods.map((period) => {
    const entry = byPeriod.get(period);
    const bands = PROVIDER_ORDER.map((provider) => ({
      provider,
      value: valueFor(entry, provider, metric),
    }));
    return { bands, total: bands.reduce((sum, band) => sum + band.value, 0) };
  });
}

/** Shape-preserving cubic tangents that cannot overshoot spiky usage data. */
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

interface CurveSegment {
  readonly from: Point;
  readonly c1: Point;
  readonly c2: Point;
  readonly to: Point;
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
 * Values are absolute, not cumulative: each provider is drawn from the same
 * zero baseline so the chart never implies that one provider is always larger.
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
  return buildPeriodColumns(days, byDay, metric);
}

/**
 * Inclusive day bounds of a brush selection, or null for a plain click.
 * Endpoints may arrive in either drag direction.
 */
export function brushSelection(
  days: readonly string[],
  startIndex: number,
  endIndex: number,
): { readonly sinceDay: string; readonly untilDay: string } | null {
  if (startIndex === endIndex) return null;
  const [first, last] = startIndex < endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
  const sinceDay = days[first];
  const untilDay = days[last];
  if (sinceDay === undefined || untilDay === undefined) return null;
  return { sinceDay, untilDay };
}

/** Period index beneath a pointer, clamped when pointer capture moves outside the plot. */
export function periodIndexAt(
  clientX: number,
  plotLeft: number,
  plotWidth: number,
  periodCount: number,
): number | null {
  if (plotWidth <= 0 || periodCount <= 0) return null;
  const localX = Math.min(plotWidth, Math.max(0, clientX - plotLeft));
  const fraction = localX / plotWidth;
  const index = Math.round(fraction * (periodCount - 1));
  return Math.min(periodCount - 1, Math.max(0, index));
}

export function UsageProviderChart({
  onZoomToDays,
  onResetZoom,
  providers,
  days,
  daily,
  hours,
  hourly,
  metric,
  referenceTime,
  resolution,
  timeZone,
}: UsageProviderChartProps) {
  const periods = resolution === "hour" ? hours : days;
  const byPeriod = useMemo(
    () =>
      resolution === "hour"
        ? new Map(hourly.map((entry) => [entry.hourStart, entry]))
        : new Map(daily.map((entry) => [entry.day, entry])),
    [daily, hourly, resolution],
  );
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  // Drag-selection endpoints, as period indices. Only daily windows zoom.
  const [brush, setBrush] = useState<{ readonly start: number; readonly end: number } | null>(null);
  const brushRef = useRef<{
    readonly pointerId: number;
    readonly start: number;
    readonly end: number;
  } | null>(null);
  const zoomable = resolution === "day" && onZoomToDays !== undefined;
  const plotRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const hoverPositionRef = useRef<{ x: number; y: number } | null>(null);

  const { paths, ticks, stepX, toY, series } = useMemo(() => {
    if (periods.length === 0) {
      return {
        paths: [],
        series: [] as readonly DayColumn[],
        stepX: 0,
        ticks: [0] as readonly number[],
        toY: () => VIEW_HEIGHT,
      };
    }

    const columns = buildPeriodColumns(periods, byPeriod, metric);
    // The scale tops out at the largest single provider-period, not the sum:
    // layered series each measure from zero, so a combined peak would leave
    // the plot permanently half empty.
    const peak = columns.reduce(
      (max, column) => column.bands.reduce((inner, band) => Math.max(inner, band.value), max),
      0,
    );
    const { max, ticks: tickValues } = niceScale(peak, TICK_COUNT);
    const step = periods.length === 1 ? 0 : VIEW_WIDTH / (periods.length - 1);
    // Leave room above the top gridline so the constant-width stroke is not
    // clipped when a series reaches the peak.
    const toY = (value: number) =>
      max === 0 ? VIEW_HEIGHT : VIEW_HEIGHT - (value / max) * (VIEW_HEIGHT - PLOT_TOP);

    const built = providers.map((provider) => {
      const providerIndex = PROVIDER_ORDER.indexOf(provider);
      const points = columns.map((column, periodIndex) => ({
        x: periodIndex * step,
        y: toY(column.bands[providerIndex]?.value ?? 0),
      }));
      const line = curvePath(smoothCurve(spanSinglePeriodPoints(points)));
      return {
        provider,
        total: columns.reduce((sum, column) => sum + (column.bands[providerIndex]?.value ?? 0), 0),
        area: line === "" ? "" : `${line} L${VIEW_WIDTH},${VIEW_HEIGHT} L0,${VIEW_HEIGHT} Z`,
        line,
      };
    });

    // Paint the heavier series first so the lighter one is not buried.
    return {
      paths: built.toSorted((a, b) => b.total - a.total),
      series: columns,
      stepX: step,
      ticks: tickValues,
      toY,
    };
  }, [byPeriod, metric, periods, providers]);

  const format = metric === "tokens" ? formatTokens : formatUsd;

  const positionTooltip = useCallback(() => {
    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    const hoverPosition = hoverPositionRef.current;
    if (plot === null || tooltip === null || hoverPosition === null) return;

    const gap = 12;
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;
    const plotWidth = plot.clientWidth;
    const plotHeight = plot.clientHeight;
    const preferredLeft =
      hoverPosition.x + gap + tooltipWidth <= plotWidth
        ? hoverPosition.x + gap
        : hoverPosition.x - gap - tooltipWidth;
    const preferredTop =
      hoverPosition.y + gap + tooltipHeight <= plotHeight
        ? hoverPosition.y + gap
        : hoverPosition.y - gap - tooltipHeight;
    const left = Math.min(Math.max(0, preferredLeft), Math.max(0, plotWidth - tooltipWidth));
    const top = Math.min(Math.max(0, preferredTop), Math.max(0, plotHeight - tooltipHeight));
    plot.style.setProperty("--usage-tooltip-left", `${left}px`);
    plot.style.setProperty("--usage-tooltip-top", `${top}px`);
  }, []);

  useLayoutEffect(() => {
    if (hoverIndex === null) return;
    positionTooltip();

    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    if (plot === null || tooltip === null || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(positionTooltip);
    observer.observe(plot);
    observer.observe(tooltip);
    return () => observer.disconnect();
  }, [hoverIndex, positionTooltip]);

  const indexAt = useCallback(
    (clientX: number): number | null => {
      const plot = plotRef.current;
      if (plot === null || periods.length === 0) return null;
      const bounds = plot.getBoundingClientRect();
      return periodIndexAt(clientX, bounds.left, bounds.width, periods.length);
    },
    [periods.length],
  );

  const handleMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const plot = plotRef.current;
      if (plot === null || periods.length === 0) return;
      const bounds = plot.getBoundingClientRect();
      if (bounds.width === 0) return;
      if (brushRef.current !== null) return;
      const index = indexAt(event.clientX);
      if (index === null) return;
      const localX = Math.min(bounds.width, Math.max(0, event.clientX - bounds.left));
      const localY = Math.min(bounds.height, Math.max(0, event.clientY - bounds.top));
      hoverPositionRef.current = { x: localX, y: localY };
      positionTooltip();
      setHoverIndex(index);
    },
    [indexAt, periods.length, positionTooltip],
  );

  const trackBrush = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const activeBrush = brushRef.current;
      if (
        activeBrush === null ||
        activeBrush.pointerId !== event.pointerId ||
        !event.currentTarget.hasPointerCapture(event.pointerId)
      ) {
        return;
      }
      const index = indexAt(event.clientX);
      if (index === null || index === activeBrush.end) return;
      const nextBrush = { ...activeBrush, end: index };
      brushRef.current = nextBrush;
      setBrush(nextBrush);
    },
    [indexAt],
  );

  const beginBrush = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!zoomable || event.button !== 0 || !event.isPrimary || brushRef.current !== null) return;
      const index = indexAt(event.clientX);
      if (index === null) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      hoverPositionRef.current = null;
      setHoverIndex(null);
      const nextBrush = { pointerId: event.pointerId, start: index, end: index };
      brushRef.current = nextBrush;
      setBrush(nextBrush);
    },
    [indexAt, zoomable],
  );

  const finishBrush = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const activeBrush = brushRef.current;
      if (
        activeBrush === null ||
        activeBrush.pointerId !== event.pointerId ||
        onZoomToDays === undefined
      ) {
        return;
      }
      const end = indexAt(event.clientX) ?? activeBrush.end;
      const selection = brushSelection(days, activeBrush.start, end);
      brushRef.current = null;
      setBrush(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (selection !== null) onZoomToDays(selection.sinceDay, selection.untilDay);
    },
    [days, indexAt, onZoomToDays],
  );

  const cancelBrush = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (brushRef.current?.pointerId !== event.pointerId) return;
    brushRef.current = null;
    setBrush(null);
  }, []);

  const hoveredPeriod = hoverIndex === null ? undefined : periods[hoverIndex];
  const hoveredColumn = hoverIndex === null ? undefined : series[hoverIndex];
  const formatPeriod = (period: string) =>
    resolution === "hour" ? formatHourShort(period, timeZone) : formatDayShort(period);
  const formatTooltipPeriod = (period: string) =>
    resolution === "hour" && referenceTime !== undefined
      ? formatRelativeHourShort(period, referenceTime, timeZone)
      : formatPeriod(period);

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
          className={cn(
            "relative h-56 flex-1",
            zoomable && "cursor-crosshair touch-pan-y select-none",
          )}
          onMouseMove={handleMove}
          onPointerDown={beginBrush}
          onPointerMove={trackBrush}
          onPointerUp={finishBrush}
          onPointerCancel={cancelBrush}
          onLostPointerCapture={cancelBrush}
          onDoubleClick={onResetZoom}
          onMouseLeave={() => {
            hoverPositionRef.current = null;
            setHoverIndex(null);
          }}
        >
          <svg
            className="h-full w-full"
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`${resolution === "hour" ? "Hourly" : "Daily"} ${metric === "tokens" ? "processed tokens" : "cost"} by provider`}
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
              <path
                key={provider}
                d={area}
                fill={PROVIDER_PRESENTATION[provider].color}
                fillOpacity={0.12}
              />
            ))}
            {paths.map(({ provider, line }) => (
              <path
                key={provider}
                d={line}
                fill="none"
                stroke={PROVIDER_PRESENTATION[provider].color}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {brush === null || brush.start === brush.end ? null : (
              <rect
                x={Math.min(brush.start, brush.end) * stepX}
                y={PLOT_TOP}
                width={Math.abs(brush.end - brush.start) * stepX}
                height={VIEW_HEIGHT - PLOT_TOP}
                fill="currentColor"
                fillOpacity={0.08}
                stroke="currentColor"
                strokeWidth={1}
                className="text-muted-foreground"
                vectorEffect="non-scaling-stroke"
              />
            )}

            {hoverIndex === null || periods.length === 1 ? null : (
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

          {hoveredPeriod === undefined ? null : (
            <div
              ref={tooltipRef}
              className="surface-glass pointer-events-none absolute z-10 min-w-36 max-w-full rounded-xl border border-border/50 px-2.5 py-2 text-xs shadow-lg"
              style={{
                left: "var(--usage-tooltip-left, 0px)",
                top: "var(--usage-tooltip-top, 0px)",
              }}
            >
              <div className="mb-1 text-muted-foreground">{formatTooltipPeriod(hoveredPeriod)}</div>
              {providers.map((provider) => {
                const { label, mark: Mark } = PROVIDER_PRESENTATION[provider];
                return (
                  <div key={provider} className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <Mark className="size-3 shrink-0" aria-hidden />
                      {label}
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
        {chartLabelIndices(periods.length).map((index) => (
          <span key={index}>{formatPeriod(periods[index] ?? "")}</span>
        ))}
      </div>
    </div>
  );
}
