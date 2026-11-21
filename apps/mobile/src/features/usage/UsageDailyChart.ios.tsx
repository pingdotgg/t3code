import { Chart, Host, type ChartDataPoint } from "@expo/ui/swift-ui";
import { frame } from "@expo/ui/swift-ui/modifiers";

import type { DailyTotals } from "@t3tools/shared/usageMerge";

import { buildChartDays, type UsageChartMetric } from "./usageChartData";
import { useProviderColors } from "./usageProviders";
import { defineNativePluginFeature } from "../../plugins/features";

export const UsageDailyChart = defineNativePluginFeature(
  "native.features.usage.usage-daily-chart",
  BuiltinUsageDailyChart,
);

export interface UsageDailyChartProps {
  readonly days: readonly string[];
  readonly daily: readonly DailyTotals[];
  readonly metric: UsageChartMetric;
  readonly height: number;
}

function BuiltinUsageDailyChart({ days, daily, metric, height }: UsageDailyChartProps) {
  const colors = useProviderColors();

  const data: ChartDataPoint[] = buildChartDays(days, daily, metric).flatMap((day) =>
    day.values.map((entry) => ({
      x: day.day,
      y: entry.value,
      color: colors[entry.provider],
    })),
  );

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
