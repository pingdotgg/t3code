import {
  buildUsageChartGeometry,
  USAGE_CHART_PLOT_TOP,
  USAGE_CHART_TICK_COUNT,
  USAGE_CHART_VIEW_HEIGHT,
  USAGE_CHART_VIEW_WIDTH,
  type UsageChartMetric,
} from "@t3tools/shared/usageChart";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { DailyTotals, HourlyTotals } from "@t3tools/shared/usageMerge";
import {
  formatDayShort,
  formatHourShort,
  formatRelativeHourShort,
  formatTokens,
  formatUsd,
} from "@t3tools/shared/usageFormat";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "./usageProviders";

export type { UsageChartMetric } from "@t3tools/shared/usageChart";

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
  const chartTotals = useMemo<readonly DailyTotals[]>(
    () =>
      resolution === "hour"
        ? hourly.map((entry) => ({
            day: entry.hourStart,
            costUsd: entry.costUsd,
            totalTokens: entry.totalTokens,
            byProvider: entry.byProvider,
          }))
        : daily,
    [daily, hourly, resolution],
  );
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const hoverPositionRef = useRef<{ x: number; y: number } | null>(null);

  const {
    columns: series,
    layers,
    ticks,
    stepX,
    toY,
  } = useMemo(
    () =>
      buildUsageChartGeometry({
        days: periods,
        daily: chartTotals,
        metric,
        providers: PROVIDER_ORDER,
        width: USAGE_CHART_VIEW_WIDTH,
        height: USAGE_CHART_VIEW_HEIGHT,
        plotTop: USAGE_CHART_PLOT_TOP,
        tickCount: USAGE_CHART_TICK_COUNT,
      }),
    [chartTotals, metric, periods],
  );

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

  const handleMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const plot = plotRef.current;
      if (plot === null || periods.length === 0) return;
      const bounds = plot.getBoundingClientRect();
      if (bounds.width === 0) return;
      const localX = Math.min(bounds.width, Math.max(0, event.clientX - bounds.left));
      const localY = Math.min(bounds.height, Math.max(0, event.clientY - bounds.top));
      const fraction = localX / bounds.width;
      const index = Math.round(fraction * (periods.length - 1));
      hoverPositionRef.current = { x: localX, y: localY };
      positionTooltip();
      setHoverIndex(Math.min(periods.length - 1, Math.max(0, index)));
    },
    [periods.length, positionTooltip],
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
              style={{ top: `${(toY(tick) / USAGE_CHART_VIEW_HEIGHT) * 100}%` }}
            >
              {tick === 0 ? "0" : format(tick)}
            </span>
          ))}
        </div>

        <div
          ref={plotRef}
          className="relative h-56 flex-1"
          onMouseMove={handleMove}
          onMouseLeave={() => {
            hoverPositionRef.current = null;
            setHoverIndex(null);
          }}
        >
          <svg
            className="h-full w-full"
            viewBox={`0 0 ${USAGE_CHART_VIEW_WIDTH} ${USAGE_CHART_VIEW_HEIGHT}`}
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
                  x2={USAGE_CHART_VIEW_WIDTH}
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  strokeWidth={1}
                  className="text-border"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}

            {layers.map((layer) =>
              layer.kind === "fill" ? (
                <path
                  key={`fill-${layer.provider}`}
                  d={layer.path}
                  fill={PROVIDER_PRESENTATION[layer.provider].color}
                  fillOpacity={layer.opacity}
                />
              ) : (
                <path
                  key={`stroke-${layer.provider}`}
                  d={layer.path}
                  fill="none"
                  stroke={PROVIDER_PRESENTATION[layer.provider].color}
                  strokeWidth={layer.width}
                  vectorEffect="non-scaling-stroke"
                />
              ),
            )}

            {hoverIndex === null ? null : (
              <line
                x1={hoverIndex * stepX}
                x2={hoverIndex * stepX}
                y1={USAGE_CHART_PLOT_TOP}
                y2={USAGE_CHART_VIEW_HEIGHT}
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
              {PROVIDER_ORDER.map((provider) => {
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
