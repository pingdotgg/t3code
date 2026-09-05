import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { formatCount, formatDayShort } from "@t3tools/shared/usageFormat";
import { niceScale } from "../usage/UsageProviderChart";

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 220;
const TICK_COUNT = 4;
const PLOT_TOP = 8;

export interface ProjectActivitySeries {
  readonly id: string;
  readonly label: string;
  readonly color: string;
}

interface ProjectActivityChartProps {
  readonly series: readonly ProjectActivitySeries[];
  readonly days: readonly string[];
  readonly countsByDay: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/** Shape-preserving cubic tangents that cannot overshoot spiky day-to-day counts. */
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

/** Threads active per day, by project, over zero — mirrors the Usage chart's layering. */
export function ProjectActivityChart({ series, days, countsByDay }: ProjectActivityChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const hoverPositionRef = useRef<{ x: number; y: number } | null>(null);

  const valueFor = useCallback(
    (day: string, seriesId: string) => countsByDay.get(day)?.get(seriesId) ?? 0,
    [countsByDay],
  );

  const { paths, ticks, stepX, toY, columns } = useMemo(() => {
    if (days.length === 0) {
      return {
        paths: [],
        columns: [] as readonly (readonly { seriesId: string; value: number }[])[],
        stepX: 0,
        ticks: [0] as readonly number[],
        toY: () => VIEW_HEIGHT,
      };
    }

    const builtColumns = days.map((day) =>
      series.map((entry) => ({ seriesId: entry.id, value: valueFor(day, entry.id) })),
    );
    const peak = builtColumns.reduce(
      (max, column) => column.reduce((inner, band) => Math.max(inner, band.value), max),
      0,
    );
    const { max, ticks: tickValues } = niceScale(peak, TICK_COUNT);
    const step = days.length === 1 ? 0 : VIEW_WIDTH / (days.length - 1);
    const toYValue = (value: number) =>
      max === 0 ? VIEW_HEIGHT : VIEW_HEIGHT - (value / max) * (VIEW_HEIGHT - PLOT_TOP);

    const built = series.map((entry, seriesIndex) => {
      const line = curvePath(
        smoothCurve(
          builtColumns.map((column, dayIndex) => ({
            x: dayIndex * step,
            y: toYValue(column[seriesIndex]?.value ?? 0),
          })),
        ),
      );
      return {
        series: entry,
        total: builtColumns.reduce((sum, column) => sum + (column[seriesIndex]?.value ?? 0), 0),
        area: line === "" ? "" : `${line} L${VIEW_WIDTH},${VIEW_HEIGHT} L0,${VIEW_HEIGHT} Z`,
        line,
      };
    });

    return {
      // Paint the heavier series first so lighter ones are not buried.
      paths: built.toSorted((a, b) => b.total - a.total),
      columns: builtColumns,
      stepX: step,
      ticks: tickValues,
      toY: toYValue,
    };
  }, [days, series, valueFor]);

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

  const handleMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const plot = plotRef.current;
      if (plot === null || days.length === 0) return;
      const bounds = plot.getBoundingClientRect();
      if (bounds.width === 0) return;
      const localX = Math.min(bounds.width, Math.max(0, event.clientX - bounds.left));
      const localY = Math.min(bounds.height, Math.max(0, event.clientY - bounds.top));
      const fraction = localX / bounds.width;
      const index = Math.round(fraction * (days.length - 1));
      hoverPositionRef.current = { x: localX, y: localY };
      positionTooltip();
      setHoverIndex(Math.min(days.length - 1, Math.max(0, index)));
    },
    [days.length, positionTooltip],
  );

  const hoveredDay = hoverIndex === null ? undefined : days[hoverIndex];
  const hoveredColumn = hoverIndex === null ? undefined : columns[hoverIndex];
  const hoveredTotal = hoveredColumn?.reduce((sum, band) => sum + band.value, 0) ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <div className="relative h-48 w-10 shrink-0">
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 -translate-y-1/2 text-[10px] text-muted-foreground tabular-nums"
              style={{ top: `${(toY(tick) / VIEW_HEIGHT) * 100}%` }}
            >
              {tick === 0 ? "0" : formatCount(tick)}
            </span>
          ))}
        </div>

        <div
          ref={plotRef}
          className="relative h-48 flex-1"
          onMouseMove={handleMove}
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
            aria-label="Daily active threads by project"
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

            {paths.map(({ series: entry, area }) => (
              <path key={entry.id} d={area} fill={entry.color} fillOpacity={0.12} />
            ))}
            {paths.map(({ series: entry, line }) => (
              <path
                key={entry.id}
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
              ref={tooltipRef}
              className="surface-glass pointer-events-none absolute z-10 min-w-36 max-w-full rounded-xl border border-border/50 px-2.5 py-2 text-xs shadow-lg"
              style={{
                left: "var(--usage-tooltip-left, 0px)",
                top: "var(--usage-tooltip-top, 0px)",
              }}
            >
              <div className="mb-1 text-muted-foreground">{formatDayShort(hoveredDay)}</div>
              {series.map((entry) => (
                <div key={entry.id} className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: entry.color }}
                      aria-hidden
                    />
                    {entry.label}
                  </span>
                  <span className="text-foreground tabular-nums">
                    {formatCount(valueFor(hoveredDay, entry.id))}
                  </span>
                </div>
              ))}
              <div className="mt-1 flex items-center justify-between gap-3 border-t border-border pt-1">
                <span className="text-muted-foreground">Total</span>
                <span className="text-foreground tabular-nums">{formatCount(hoveredTotal)}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex justify-between pl-12 text-[10px] text-muted-foreground uppercase">
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
