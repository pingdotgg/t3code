import { useMemo } from "react";
import Svg, { Line, Path } from "react-native-svg";

import type { DailyTotals } from "@t3tools/shared/usageMerge";
import {
  buildUsageChartGeometry,
  USAGE_CHART_PLOT_TOP,
  USAGE_CHART_TICK_COUNT,
  USAGE_CHART_VIEW_HEIGHT,
  USAGE_CHART_VIEW_WIDTH,
  type UsageChartMetric,
} from "@t3tools/shared/usageChart";

import { useThemeColor } from "../../lib/useThemeColor";
import { PROVIDER_ORDER, useProviderColors } from "./usageProviders";

export interface UsageDailyChartProps {
  readonly days: readonly string[];
  readonly daily: readonly DailyTotals[];
  readonly metric: UsageChartMetric;
  readonly height: number;
  readonly resolution: "day" | "hour";
}

/** The same layered provider paths as desktop, rendered natively on both platforms. */
export function UsageDailyChart({ days, daily, metric, height, resolution }: UsageDailyChartProps) {
  const colors = useProviderColors();
  const borderColor = useThemeColor("--color-border");
  const { layers, ticks, toY } = useMemo(
    () =>
      buildUsageChartGeometry({
        days,
        daily,
        metric,
        providers: PROVIDER_ORDER,
        width: USAGE_CHART_VIEW_WIDTH,
        height: USAGE_CHART_VIEW_HEIGHT,
        plotTop: USAGE_CHART_PLOT_TOP,
        tickCount: USAGE_CHART_TICK_COUNT,
      }),
    [daily, days, metric],
  );

  return (
    <Svg
      width="100%"
      height={height}
      viewBox={`0 0 ${USAGE_CHART_VIEW_WIDTH} ${USAGE_CHART_VIEW_HEIGHT}`}
      preserveAspectRatio="none"
      accessibilityRole="image"
      accessibilityLabel={`${resolution === "hour" ? "Hourly" : "Daily"} ${metric === "tokens" ? "processed tokens" : "cost"} by provider`}
    >
      {ticks.map((tick) => {
        const y = toY(tick);
        return (
          <Line
            key={tick}
            x1={0}
            x2={USAGE_CHART_VIEW_WIDTH}
            y1={y}
            y2={y}
            stroke={String(borderColor)}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}

      {layers.map((layer) =>
        layer.kind === "fill" ? (
          <Path
            key={`fill-${layer.provider}`}
            d={layer.path}
            fill={colors[layer.provider]}
            fillOpacity={layer.opacity}
          />
        ) : (
          <Path
            key={`stroke-${layer.provider}`}
            d={layer.path}
            fill="none"
            stroke={colors[layer.provider]}
            strokeWidth={layer.width}
            vectorEffect="non-scaling-stroke"
          />
        ),
      )}
    </Svg>
  );
}
