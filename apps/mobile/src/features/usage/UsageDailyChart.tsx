import { View } from "react-native";

import type { DailyTotals } from "@t3tools/shared/usageMerge";

import { buildChartDays, type UsageChartMetric } from "./usageChartData";
import { useProviderColors } from "./usageProviders";

export interface UsageDailyChartProps {
  readonly days: readonly string[];
  readonly daily: readonly DailyTotals[];
  readonly metric: UsageChartMetric;
  readonly height: number;
}

export function UsageDailyChart({ days, daily, metric, height }: UsageDailyChartProps) {
  const colors = useProviderColors();
  const chartDays = buildChartDays(days, daily, metric);
  const max = chartDays.reduce((peak, day) => Math.max(peak, day.total), 0);

  return (
    <View style={{ height }} className="flex-row items-end gap-px">
      {/* column-reverse stacks the bottom-first provider values upward
          without reversing the array (Hermes lacks Array#toReversed).
          Each column is only as tall as its stack so the rounding clips the
          bar's top, not empty space above it. */}
      {chartDays.map((day) => (
        <View
          key={day.day}
          style={{ height: max === 0 ? 0 : (day.total / max) * height }}
          className="flex-1 flex-col-reverse overflow-hidden rounded-t-sm"
        >
          {day.values.map((entry) => (
            <View
              key={entry.provider}
              style={{
                height: max === 0 ? 0 : (entry.value / max) * height,
                backgroundColor: colors[entry.provider],
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}
