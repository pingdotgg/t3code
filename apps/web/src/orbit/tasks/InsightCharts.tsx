import { useId, useLayoutEffect, useRef, useState, type PointerEvent } from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

import type { TrendPoint } from "./tasksInsights.logic";

// Plain SVG measured to its box, so lines and text stay crisp at any width. Lines take theme
// colours; text stays in text colours.

function useBoxSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the SVG is drawn at the box's measured size
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () =>
      setSize({
        width: Math.round(element.clientWidth),
        height: Math.round(element.clientHeight),
      });
    measure();
    return observeResize(element, measure);
  }, []);
  return [ref, size] as const;
}

type Placed = { readonly x: number; readonly y: number };

/** Splits at missing values, so a gap in the data is a gap in the line. */
function segments(points: ReadonlyArray<{ x: number; y: number | null }>) {
  const runs: Placed[][] = [];
  let run: Placed[] = [];
  for (const point of points) {
    if (point.y === null) {
      if (run.length > 0) runs.push(run);
      run = [];
    } else run.push({ x: point.x, y: point.y });
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

const pathOf = (run: ReadonlyArray<Placed>) =>
  run
    .map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(" ");

const areaOf = (run: ReadonlyArray<Placed>, baseline: number) =>
  `${pathOf(run)} L${run.at(-1)!.x.toFixed(1)},${baseline} L${run[0]!.x.toFixed(1)},${baseline} Z`;

function Fade(props: { id: string; color: string; opacity: number }) {
  return (
    <linearGradient id={props.id} x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stopColor={props.color} stopOpacity={props.opacity} />
      <stop offset="100%" stopColor={props.color} stopOpacity={0} />
    </linearGradient>
  );
}

function extent(values: ReadonlyArray<number>) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min) * 0.12 || Math.abs(max) * 0.1 || 1;
  return [min - pad, max + pad] as const;
}

/** An axis on round steps (1, 2, 2.5 or 5 × 10ⁿ) that covers the data in at most four gridlines. */
function niceScale(min: number, max: number) {
  const span = max - min || Math.abs(max) || 1;
  const power = 10 ** Math.floor(Math.log10(span / 3));
  const candidates = [1, 2, 2.5, 5, 10, 20, 25, 50].map((factor) => factor * power);
  const fits = (step: number) => Math.ceil(max / step) - Math.floor(min / step) <= 3;
  const step = candidates.find(fits) ?? candidates.at(-1)!;
  const low = Math.floor(min / step) * step;
  const high = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let tick = low; tick <= high + step / 2; tick += step) {
    ticks.push(Math.round(tick / step) * step);
  }
  return { low, high: high === low ? low + step : high, ticks };
}

const SHORT_DATE = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const dateLabel = (date: string) => {
  const time = Date.parse(`${date}T00:00:00`);
  return Number.isNaN(time) ? date : SHORT_DATE.format(time);
};

/** A small area in the de-emphasis colour, straight segments, no markers. The right edge is now. */
export function Sparkline(props: { points: ReadonlyArray<TrendPoint>; className?: string }) {
  const [ref, { width }] = useBoxSize<HTMLDivElement>();
  const fade = `fade${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const height = 28;
  const values = props.points.flatMap((point) => (point.value === null ? [] : [point.value]));
  const [low, high] = values.length > 0 ? extent(values) : [0, 1];
  const x = (index: number) => 1 + (index / Math.max(1, props.points.length - 1)) * (width - 2);
  const y = (value: number) => height - 3 - ((value - low) / (high - low)) * (height - 6);
  const placed = props.points.map((point, index) => ({
    x: x(index),
    y: point.value === null ? null : y(point.value),
  }));
  return (
    <div ref={ref} aria-hidden className={cn("h-7 w-full text-muted-foreground", props.className)}>
      {width > 0 && values.length > 1 ? (
        <svg width={width} height={height} className="block overflow-visible">
          <defs>
            <Fade id={fade} color="currentColor" opacity={0.22} />
          </defs>
          {segments(placed).map((run) => (
            <g key={run[0]!.x}>
              <path d={areaOf(run, height)} fill={`url(#${fade})`} />
              <path
                d={pathOf(run)}
                fill="none"
                stroke="currentColor"
                strokeOpacity={0.7}
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>
          ))}
        </svg>
      ) : null}
    </div>
  );
}

export interface ChartSeries {
  readonly name: string;
  /** A theme colour, such as `var(--info)`. */
  readonly color: string;
  readonly points: ReadonlyArray<TrendPoint>;
}

/** Axis labels (2xs, the document's font), measured once per text. */
const labelWidths = new Map<string, number>();
let measureContext: CanvasRenderingContext2D | null = null;
function measureLabel(text: string) {
  const known = labelWidths.get(text);
  if (known !== undefined) return known;
  measureContext ??= document.createElement("canvas").getContext("2d");
  if (!measureContext) return text.length * 6.5;
  measureContext.font = `11px ${getComputedStyle(document.body).fontFamily}`;
  // The labels use tabular figures, so every digit is as wide as a 0.
  const width = measureContext.measureText(text.replace(/[0-9]/g, "0")).width;
  labelWidths.set(text, width);
  return width;
}

/**
 * One line per series over the period, one y-axis, recessive grid. A crosshair snaps to the
 * nearest point and the tooltip lists every series there. Fills its parent's height.
 */
export function TrendChart(props: {
  series: ReadonlyArray<ChartSeries>;
  format: (value: number) => string;
  label: string;
}) {
  const [ref, { width, height }] = useBoxSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const fade = `fade${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const count = props.series[0]?.points.length ?? 0;
  const values = props.series.flatMap((series) =>
    series.points.flatMap((point) => (point.value === null ? [] : [point.value])),
  );
  const { low, high, ticks } = niceScale(
    values.length > 0 ? Math.min(...values) : 0,
    values.length > 0 ? Math.max(...values) : 1,
  );
  // The axis column is as wide as its widest label, so that label starts on the text's left edge.
  const labelWidth = Math.ceil(Math.max(...ticks.map((tick) => measureLabel(props.format(tick)))));
  const margin = { top: 6, right: 2, bottom: 24, left: labelWidth + 10 };
  const plotWidth = Math.max(0, width - margin.left - margin.right);
  const plotHeight = height - margin.top - margin.bottom;
  const x = (index: number) => margin.left + (index / Math.max(1, count - 1)) * plotWidth;
  const y = (value: number) =>
    margin.top + plotHeight - ((value - low) / (high - low)) * plotHeight;
  const placedRuns = (series: ChartSeries) =>
    segments(
      series.points.map((point, index) => ({
        x: x(index),
        y: point.value === null ? null : y(point.value),
      })),
    );
  const onMove = (event: PointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - box.left) / box.width;
    setHover(Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1)))));
  };
  const hoverDate = hover === null ? undefined : props.series[0]?.points[hover]?.date;
  const axisIndexes = [...new Set([0, Math.floor((count - 1) / 2), count - 1])];
  return (
    <div ref={ref} className="relative size-full min-h-0">
      {width > 0 && height > 40 ? (
        <svg width={width} height={height} className="block" role="img" aria-label={props.label}>
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={margin.left}
                x2={margin.left + plotWidth}
                y1={y(tick)}
                y2={y(tick)}
                className="stroke-(--shell-divider)"
                strokeWidth={1}
              />
              <text
                x={labelWidth}
                y={y(tick)}
                dy="0.32em"
                textAnchor="end"
                className="fill-muted-foreground text-2xs tabular-nums"
              >
                {props.format(tick)}
              </text>
            </g>
          ))}
          {axisIndexes.map((index) => (
            <text
              key={index}
              x={x(index)}
              y={height - 6}
              textAnchor={index === 0 ? "start" : index === count - 1 ? "end" : "middle"}
              className="fill-muted-foreground text-2xs"
            >
              {dateLabel(props.series[0]?.points[index]?.date ?? "")}
            </text>
          ))}
          {hover !== null ? (
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={margin.top}
              y2={margin.top + plotHeight}
              className="stroke-muted-foreground/50"
              strokeWidth={1}
            />
          ) : null}
          <defs>
            {props.series.map((series, index) => (
              <Fade key={series.name} id={`${fade}-${index}`} color={series.color} opacity={0.18} />
            ))}
          </defs>
          {/* Areas first, lines on top, so every line stays readable where the fills overlap. */}
          {props.series.map((series, seriesIndex) =>
            placedRuns(series).map((run) => (
              <path
                key={`${series.name}-area-${run[0]!.x}`}
                d={areaOf(run, margin.top + plotHeight)}
                fill={`url(#${fade}-${seriesIndex})`}
              />
            )),
          )}
          {props.series.map((series) =>
            placedRuns(series).map((run) => (
              <path
                key={`${series.name}-${run[0]!.x}`}
                d={pathOf(run)}
                fill="none"
                stroke={series.color}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )),
          )}
          {hover !== null
            ? props.series.map((series) => {
                const value = series.points[hover]?.value;
                return value === null || value === undefined ? null : (
                  <circle
                    key={series.name}
                    cx={x(hover)}
                    cy={y(value)}
                    r={4.5}
                    fill={series.color}
                    className="stroke-(--shell-card)"
                    strokeWidth={2}
                  />
                );
              })
            : null}
          <rect
            x={margin.left}
            y={margin.top}
            width={plotWidth}
            height={Math.max(0, plotHeight)}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
      ) : null}
      {hover !== null && hoverDate !== undefined ? (
        <div
          className="pointer-events-none absolute top-1 z-10 min-w-36 rounded-lg border border-(--shell-divider)! bg-popover px-2.5 py-2 text-ui shadow-md"
          style={x(hover) > width / 2 ? { right: width - x(hover) + 10 } : { left: x(hover) + 10 }}
        >
          <div className="mb-1 text-muted-foreground">{dateLabel(hoverDate)}</div>
          {props.series.map((series) => {
            const value = series.points[hover]?.value;
            return (
              <div key={series.name} className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="h-0.5 w-3 rounded-full"
                  style={{ backgroundColor: series.color }}
                />
                <span className="flex-1 text-foreground">{series.name}</span>
                <span className="text-foreground tabular-nums">
                  {value === null || value === undefined ? "–" : props.format(value)}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
