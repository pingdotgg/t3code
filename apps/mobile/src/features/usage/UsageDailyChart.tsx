import { useMemo } from "react";
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

/**
 * Stacked daily bars drawn with plain views. Android and any platform without
 * Swift Charts land here; iOS resolves `UsageDailyChart.ios.tsx` instead.
 */
export function UsageDailyChart({ days, daily, metric, height }: UsageDailyChartProps) {
  const colors = useProviderColors();
  const chartDays = useMemo(() => buildChartDays(days, daily, metric), [days, daily, metric]);
  const max = chartDays.reduce((peak, day) => Math.max(peak, day.total), 0);

  return (
    <View style={{ height }} className="flex-row items-end gap-px">
      {/* column-reverse stacks the bottom-first provider values upward
          without reversing the array (Hermes lacks Array#toReversed). */}
      {chartDays.map((day) => (
        <View key={day.day} className="h-full flex-1 flex-col-reverse overflow-hidden rounded-sm">
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
