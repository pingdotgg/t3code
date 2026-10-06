import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import type { ChartColumn } from "./usageExplorerModel";
import { type CurveSegment, niceScale, type Point, smoothCurve } from "./UsageProviderChart";

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 260;
const PLOT_TOP = 8;
const TICK_COUNT = 4;
const READOUT_ROWS = 8;

export interface StackedSeries {
  readonly key: string;
  readonly label: string;
  readonly color: string;
}

/**
 * Keeps a stacked edge on or above the edge beneath it. Both share their x
 * positions, and a cubic stays within its control points, so holding the
 * control points above the lower edge's keeps every band at zero thickness
 * or more. The data points themselves are already in order.
 */
function clampAbove(segments: readonly CurveSegment[], below: readonly CurveSegment[] | null) {
  if (below === null) return segments;
  return segments.map((segment, index) => {
    const under = below[index];
    if (under === undefined) return segment;
    return {
      from: { x: segment.from.x, y: Math.min(segment.from.y, under.from.y) },
      c1: { x: segment.c1.x, y: Math.min(segment.c1.y, under.c1.y) },
      c2: { x: segment.c2.x, y: Math.min(segment.c2.y, under.c2.y) },
      to: { x: segment.to.x, y: Math.min(segment.to.y, under.to.y) },
    };
  });
}

const f2 = (value: number) => value.toFixed(2);
const forward = (segments: readonly CurveSegment[]) =>
  segments
    .map(
      (s, i) =>
        `${i === 0 ? `M${f2(s.from.x)},${f2(s.from.y)} ` : ""}C${f2(s.c1.x)},${f2(s.c1.y)} ${f2(s.c2.x)},${f2(s.c2.y)} ${f2(s.to.x)},${f2(s.to.y)}`,
    )
    .join(" ");
const backward = (segments: readonly CurveSegment[]) => {
  const last = segments[segments.length - 1];
  if (last === undefined) return "";
  return (
    `L${f2(last.to.x)},${f2(last.to.y)} ` +
    segments
      .toReversed()
      .map(
        (s) =>
          `C${f2(s.c2.x)},${f2(s.c2.y)} ${f2(s.c1.x)},${f2(s.c1.y)} ${f2(s.from.x)},${f2(s.from.y)}`,
      )
      .join(" ")
  );
};

/**
 * Usage per interval, stacked by series. Each value sits at its interval's
 * centre and the curve runs flat to both edges, so the plot spans the whole
 * first and last interval. Hovering anywhere reads out the interval; dragging
 * across intervals zooms into them.
 */
export function UsageStackedChart({
  columns,
  series,
  format,
  formatAxis,
  formatBin,
  running,
  highlightKey,
  onHoverSeries,
  onZoom,
  ariaLabel,
}: {
  readonly columns: readonly ChartColumn[];
  readonly series: readonly StackedSeries[];
  readonly format: (value: number) => string;
  readonly formatAxis: (value: number) => string;
  readonly formatBin: (bin: string) => string;
  readonly running: boolean;
  /** A series emphasised from outside, such as the hovered table row. */
  readonly highlightKey: string | null;
  readonly onHoverSeries: (key: string | null) => void;
  /** Called with the first and last interval of a drag. */
  readonly onZoom?: (firstBin: string, lastBin: string) => void;
  readonly ariaLabel: string;
}) {
  const plotRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [hoverSeries, setHoverSeries] = useState<string | null>(null);
  const [brush, setBrush] = useState<{ from: number; to: number } | null>(null);
  const count = columns.length;

  const geometry = useMemo(() => {
    const peak = columns.reduce((max, column) => Math.max(max, column.total), 0);
    const scale = niceScale(peak, TICK_COUNT);
    const toY = (value: number) =>
      scale.max === 0 ? VIEW_HEIGHT : VIEW_HEIGHT - (value / scale.max) * (VIEW_HEIGHT - PLOT_TOP);
    const width = count === 0 ? VIEW_WIDTH : VIEW_WIDTH / count;
    const xs = [0, ...columns.map((_, index) => (index + 0.5) * width), VIEW_WIDTH];
    // Running sums from the bottom series up: edge k is the top of series k.
    const edges: number[][] = series.map(() => []);
    for (const column of columns) {
      let sum = 0;
      series.forEach((_, k) => {
        sum += column.values[k] ?? 0;
        edges[k]!.push(sum);
      });
    }
    const curves: CurveSegment[][] = [];
    edges.forEach((edge, k) => {
      const values = [edge[0] ?? 0, ...edge, edge[edge.length - 1] ?? 0];
      const points: Point[] = values.map((value, i) => ({ x: xs[i]!, y: toY(value) }));
      curves.push([...clampAbove(smoothCurve(points), k === 0 ? null : curves[k - 1]!)]);
    });
    const baseline: CurveSegment[] = xs.slice(1).map((x, i) => ({
      from: { x: xs[i]!, y: VIEW_HEIGHT },
      c1: { x: xs[i]!, y: VIEW_HEIGHT },
      c2: { x, y: VIEW_HEIGHT },
      to: { x, y: VIEW_HEIGHT },
    }));
    const bands = series.map((entry, k) => {
      const top = curves[k] ?? [];
      const bottom = k === 0 ? baseline : (curves[k - 1] ?? baseline);
      return {
        key: entry.key,
        color: entry.color,
        d: top.length === 0 ? "" : `${forward(top)} ${backward(bottom)} Z`,
      };
    });
    const topCurve = curves[curves.length - 1];
    return {
      ticks: scale.ticks,
      toY,
      width,
      bands,
      totalLine: topCurve === undefined ? "" : forward(topCurve),
    };
  }, [columns, count, series]);

  const binAt = useCallback(
    (clientX: number) => {
      const plot = plotRef.current;
      if (plot === null || count === 0) return null;
      const bounds = plot.getBoundingClientRect();
      if (bounds.width === 0) return null;
      const index = Math.floor(((clientX - bounds.left) / bounds.width) * count);
      return Math.min(count - 1, Math.max(0, index));
    },
    [count],
  );

  /** The band under the pointer, read from the stacked values at that interval. */
  const seriesAt = useCallback(
    (index: number, clientY: number) => {
      const plot = plotRef.current;
      const column = columns[index];
      if (plot === null || column === undefined) return null;
      const bounds = plot.getBoundingClientRect();
      const y = ((clientY - bounds.top) / bounds.height) * VIEW_HEIGHT;
      let sum = 0;
      for (const [k, entry] of series.entries()) {
        const bottom = geometry.toY(sum);
        sum += column.values[k] ?? 0;
        if (y <= bottom && y >= geometry.toY(sum)) return entry.key;
      }
      return null;
    },
    [columns, geometry, series],
  );

  const positionTooltip = useCallback(() => {
    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    const pointer = pointerRef.current;
    if (plot === null || tooltip === null || pointer === null) return;
    const gap = 12;
    const left =
      pointer.x + gap + tooltip.offsetWidth <= plot.clientWidth
        ? pointer.x + gap
        : pointer.x - gap - tooltip.offsetWidth;
    const top =
      pointer.y + gap + tooltip.offsetHeight <= plot.clientHeight
        ? pointer.y + gap
        : pointer.y - gap - tooltip.offsetHeight;
    plot.style.setProperty(
      "--usage-tooltip-left",
      `${Math.min(Math.max(0, left), Math.max(0, plot.clientWidth - tooltip.offsetWidth))}px`,
    );
    plot.style.setProperty(
      "--usage-tooltip-top",
      `${Math.min(Math.max(0, top), Math.max(0, plot.clientHeight - tooltip.offsetHeight))}px`,
    );
  }, []);

  useLayoutEffect(() => {
    if (hoverIndex !== null) positionTooltip();
  }, [hoverIndex, positionTooltip]);

  const onMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const plot = plotRef.current;
    const index = binAt(event.clientX);
    if (plot === null || index === null) return;
    const bounds = plot.getBoundingClientRect();
    pointerRef.current = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    setHoverIndex(index);
    const key = seriesAt(index, event.clientY);
    if (key !== hoverSeries) {
      setHoverSeries(key);
      onHoverSeries(key);
    }
    if (brush !== null) setBrush({ from: brush.from, to: index });
    positionTooltip();
  };

  const finishBrush = () => {
    if (brush === null) return;
    const first = Math.min(brush.from, brush.to);
    const last = Math.max(brush.from, brush.to);
    setBrush(null);
    const firstBin = columns[first]?.bin;
    const lastBin = columns[last]?.bin;
    if (first !== last && firstBin !== undefined && lastBin !== undefined) {
      onZoom?.(firstBin, lastBin);
    }
  };

  const hovered = hoverIndex === null ? undefined : columns[hoverIndex];
  const wanted = hoverSeries ?? highlightKey;
  const emphasis = wanted !== null && series.some((entry) => entry.key === wanted) ? wanted : null;
  const readout =
    hovered === undefined
      ? []
      : series
          .map((entry, k) => ({ entry, value: hovered.values[k] ?? 0 }))
          .filter((row) => row.value > 0)
          .sort((a, b) => b.value - a.value)
          .slice(0, READOUT_ROWS);
  const centre = (index: number) => ((index + 0.5) / Math.max(1, count)) * 100;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <div className="relative h-56 w-14 shrink-0">
          {geometry.ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 -translate-y-1/2 text-3xs text-muted-foreground tabular-nums"
              style={{ top: `${(geometry.toY(tick) / VIEW_HEIGHT) * 100}%` }}
            >
              {tick === 0 ? "0" : formatAxis(tick)}
            </span>
          ))}
        </div>
        <div
          ref={plotRef}
          className={cn("relative h-56 flex-1 select-none", onZoom && "cursor-crosshair")}
          onMouseMove={onMove}
          onMouseDown={(event) => {
            if (event.button !== 0 || onZoom === undefined) return;
            const index = binAt(event.clientX);
            if (index === null) return;
            event.preventDefault();
            setBrush({ from: index, to: index });
          }}
          onMouseUp={finishBrush}
          onMouseLeave={() => {
            pointerRef.current = null;
            setHoverIndex(null);
            setBrush(null);
            if (hoverSeries !== null) {
              setHoverSeries(null);
              onHoverSeries(null);
            }
          }}
        >
          <svg
            className="h-full w-full"
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={ariaLabel}
          >
            {geometry.ticks.map((tick) => (
              <line
                key={tick}
                x1={0}
                x2={VIEW_WIDTH}
                y1={geometry.toY(tick)}
                y2={geometry.toY(tick)}
                stroke="currentColor"
                strokeWidth={1}
                className="text-border"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {geometry.bands.map((band) => (
              <path
                key={band.key}
                d={band.d}
                // Through style: colours can be CSS variables, which SVG attributes do not resolve.
                style={{ fill: band.color }}
                fillOpacity={emphasis === null ? 0.7 : emphasis === band.key ? 0.9 : 0.2}
              />
            ))}
            {geometry.totalLine === "" ? null : (
              <path
                d={geometry.totalLine}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                className="text-foreground/80"
                vectorEffect="non-scaling-stroke"
              />
            )}
            {brush === null ? null : (
              <rect
                x={Math.min(brush.from, brush.to) * geometry.width}
                width={(Math.abs(brush.to - brush.from) + 1) * geometry.width}
                y={0}
                height={VIEW_HEIGHT}
                className="fill-foreground/10"
              />
            )}
            {hoverIndex === null ? null : (
              <line
                x1={(hoverIndex + 0.5) * geometry.width}
                x2={(hoverIndex + 0.5) * geometry.width}
                y1={PLOT_TOP}
                y2={VIEW_HEIGHT}
                stroke="currentColor"
                strokeWidth={1}
                className="text-muted-foreground"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          {/* Dots are HTML: in the stretched SVG a circle would draw as an ellipse. */}
          {hovered === undefined || hoverIndex === null
            ? null
            : [
                ...series.map((entry, k) => {
                  const value = hovered.values.slice(0, k + 1).reduce((sum, v) => sum + v, 0);
                  if ((hovered.values[k] ?? 0) === 0) return null;
                  return (
                    <span
                      key={entry.key}
                      aria-hidden
                      className={cn(
                        "pointer-events-none absolute size-2 -translate-1/2 rounded-full border border-background",
                        emphasis !== null && emphasis !== entry.key && "opacity-40",
                      )}
                      style={{
                        left: `${centre(hoverIndex)}%`,
                        top: `${(geometry.toY(value) / VIEW_HEIGHT) * 100}%`,
                        backgroundColor: entry.color,
                      }}
                    />
                  );
                }),
                <span
                  key="total"
                  aria-hidden
                  className="pointer-events-none absolute size-2 -translate-1/2 rounded-full border border-background bg-foreground"
                  style={{
                    left: `${centre(hoverIndex)}%`,
                    top: `${(geometry.toY(hovered.total) / VIEW_HEIGHT) * 100}%`,
                  }}
                />,
              ]}
          {hovered === undefined ? null : (
            <div
              ref={tooltipRef}
              className="surface-glass pointer-events-none absolute z-10 min-w-44 max-w-full rounded-xl border border-border/50 px-2.5 py-2 text-xs shadow-lg"
              style={{
                left: "var(--usage-tooltip-left, 0px)",
                top: "var(--usage-tooltip-top, 0px)",
              }}
            >
              <div className="mb-1 text-muted-foreground">{formatBin(hovered.bin)}</div>
              {readout.map(({ entry, value }) => (
                <div
                  key={entry.key}
                  className={cn(
                    "flex items-center justify-between gap-3",
                    emphasis === entry.key && "font-medium",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-sm"
                      style={{ backgroundColor: entry.color }}
                    />
                    <span className="truncate">{entry.label}</span>
                  </span>
                  <span className="text-foreground tabular-nums">{format(value)}</span>
                </div>
              ))}
              <div className="mt-1 flex items-center justify-between gap-3 border-t border-border pt-1">
                <span className="text-muted-foreground">{running ? "Running total" : "Total"}</span>
                <span className="text-foreground tabular-nums">{format(hovered.total)}</span>
              </div>
              {running ? (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">This interval</span>
                  <span className="text-foreground tabular-nums">+{format(hovered.own)}</span>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
      <div className="flex justify-between pl-16 text-3xs text-muted-foreground uppercase">
        {[...new Set(count === 0 ? [] : [0, Math.floor(count / 2), count - 1])].map((index) => (
          <span key={columns[index]?.bin ?? index}>{formatBin(columns[index]?.bin ?? "")}</span>
        ))}
      </div>
    </div>
  );
}
