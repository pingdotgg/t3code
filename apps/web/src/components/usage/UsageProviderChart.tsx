import type { UsageProviderKind } from "@t3tools/contracts";
import { useCallback, useMemo, useRef, useState } from "react";

import type { DailyTotals, HourlyTotals } from "@t3tools/shared/usageMerge";
import {
  formatDayShort,
  formatHourShort,
  formatRelativeHourShort,
  formatTokens,
  formatUsd,
} from "@t3tools/shared/usageFormat";
import { PROVIDER_COLOR, PROVIDER_LABEL, PROVIDER_MARK, PROVIDER_ORDER } from "./usageProviders";

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 260;
const TICK_COUNT = 4;
const PLOT_TOP = 8;

export type UsageChartMetric = "tokens" | "cost";

interface UsageProviderChartProps {
  readonly days: readonly string[];
  readonly daily: readonly DailyTotals[];
  readonly hours: readonly string[];
  readonly hourly: readonly HourlyTotals[];
  readonly metric: UsageChartMetric;
  readonly referenceTime: string | undefined;
  readonly resolution: "day" | "hour";
  readonly timeZone: string;
}

/** One day's per-provider values, shared by the bars and the hover readout. */
export interface DayColumn {
  readonly bands: readonly {
    readonly provider: UsageProviderKind;
    readonly value: number;
  }[];
  readonly total: number;
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
 * Values stay absolute in the data model. The renderer stacks them in the
 * stable provider order, which keeps the individual values available to the
 * hover readout while making the bar height equal the period total.
 *
 * The chart bars and the hover readout both consume this, so the number under
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

export function UsageProviderChart({
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
  const plotRef = useRef<HTMLDivElement | null>(null);

  const { barWidth, series, slotWidth, ticks, toY } = useMemo(() => {
    if (periods.length === 0) {
      return {
        barWidth: 0,
        series: [] as readonly DayColumn[],
        slotWidth: 0,
        ticks: [0] as readonly number[],
        toY: () => VIEW_HEIGHT,
      };
    }

    const columns = buildPeriodColumns(periods, byPeriod, metric);
    const peak = columns.reduce((max, column) => Math.max(max, column.total), 0);
    const { max, ticks: tickValues } = niceScale(peak, TICK_COUNT);
    const slot = VIEW_WIDTH / periods.length;
    const width = Math.max(2, Math.min(48, slot * 0.72));
    const toY = (value: number) =>
      max === 0 ? VIEW_HEIGHT : VIEW_HEIGHT - (value / max) * (VIEW_HEIGHT - PLOT_TOP);

    return {
      barWidth: width,
      series: columns,
      slotWidth: slot,
      ticks: tickValues,
      toY,
    };
  }, [byPeriod, metric, periods]);

  const format = metric === "tokens" ? formatTokens : formatUsd;

  const handleMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const plot = plotRef.current;
      if (plot === null || periods.length === 0) return;
      const bounds = plot.getBoundingClientRect();
      if (bounds.width === 0) return;
      const localX = Math.min(bounds.width, Math.max(0, event.clientX - bounds.left));
      const localY = Math.min(bounds.height, Math.max(0, event.clientY - bounds.top));
      const fraction = localX / bounds.width;
      const index = Math.floor(fraction * periods.length);
      plot.style.setProperty("--usage-tooltip-x", `${localX}px`);
      plot.style.setProperty("--usage-tooltip-y", `${localY}px`);
      plot.style.setProperty(
        "--usage-tooltip-shift-x",
        localX > bounds.width * 0.65 ? "calc(-100% - 12px)" : "12px",
      );
      plot.style.setProperty(
        "--usage-tooltip-shift-y",
        localY > bounds.height * 0.55 ? "calc(-100% - 12px)" : "12px",
      );
      setHoverIndex(Math.min(periods.length - 1, Math.max(0, index)));
    },
    [periods.length],
  );

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
          className="relative h-56 flex-1"
          onMouseMove={handleMove}
          onMouseLeave={() => setHoverIndex(null)}
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

            {hoverIndex === null ? null : (
              <rect
                x={hoverIndex * slotWidth}
                y={0}
                width={slotWidth}
                height={VIEW_HEIGHT}
                fill="currentColor"
                fillOpacity={0.3}
                className="text-muted"
              />
            )}

            {series.flatMap((column, columnIndex) => {
              let stackedValue = 0;
              return column.bands.map((band) => {
                const bottom = toY(stackedValue);
                stackedValue += band.value;
                const top = toY(stackedValue);
                return (
                  <rect
                    key={`${columnIndex}:${band.provider}`}
                    x={columnIndex * slotWidth + (slotWidth - barWidth) / 2}
                    y={top}
                    width={barWidth}
                    height={Math.max(0, bottom - top)}
                    rx={Math.min(1.5, barWidth / 4)}
                    fill={PROVIDER_COLOR[band.provider]}
                  />
                );
              });
            })}
          </svg>

          {hoveredPeriod === undefined ? null : (
            <div
              className="pointer-events-none absolute z-10 min-w-36 rounded-xl border border-border/50 bg-background/65 px-2.5 py-2 text-xs shadow-lg backdrop-blur-xl backdrop-saturate-150 will-change-transform"
              style={{
                left: "var(--usage-tooltip-x, 0px)",
                top: "var(--usage-tooltip-y, 0px)",
                transform:
                  "translate(var(--usage-tooltip-shift-x, 12px), var(--usage-tooltip-shift-y, 12px))",
              }}
            >
              <div className="mb-1 text-muted-foreground">{formatTooltipPeriod(hoveredPeriod)}</div>
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
        <span>{periods[0] === undefined ? "" : formatPeriod(periods[0])}</span>
        <span>
          {periods[Math.floor(periods.length / 2)] === undefined
            ? ""
            : formatPeriod(periods[Math.floor(periods.length / 2)] ?? "")}
        </span>
        <span>
          {periods[periods.length - 1] === undefined
            ? ""
            : formatPeriod(periods[periods.length - 1] ?? "")}
        </span>
      </div>
    </div>
  );
}
