import { Chart, Host, type ChartDataPoint } from "@expo/ui/swift-ui";
import { frame } from "@expo/ui/swift-ui/modifiers";
import { useMemo } from "react";

import type { DailyTotals } from "@t3tools/shared/usageMerge";

import { buildChartDays, type UsageChartMetric } from "./usageChartData";
import { useProviderColors } from "./usageProviders";

export interface UsageDailyChartProps {
  readonly days: readonly string[];
  readonly daily: readonly DailyTotals[];
  readonly metric: UsageChartMetric;
  readonly height: number;
}

/**
 * Native Swift Charts daily bars. Points sharing an x value stack, so emitting
 * one point per provider per day yields per-provider bands whose stack height
 * is the day's total; changes animate natively.
 *
 * Axes are hidden: 30-90 categorical day labels cannot fit on a phone, so the
 * screen renders its own edge labels under the chart instead.
 */
export function UsageDailyChart({ days, daily, metric, height }: UsageDailyChartProps) {
  const colors = useProviderColors();

  const data = useMemo((): ChartDataPoint[] => {
    return buildChartDays(days, daily, metric).flatMap((day) =>
      day.values.map((entry) => ({
        x: day.day,
        y: entry.value,
        color: colors[entry.provider],
      })),
    );
  }, [days, daily, metric, colors]);

  return (
    <Host style={{ height, width: "100%" }}>
      <Chart
        type="bar"
        data={data}
        animate
        showGrid={false}
        barStyle={{ cornerRadius: 2 }}
        modifiers={[frame({ height })]}
      />
    </Host>
  );
}
