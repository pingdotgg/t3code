import { BarChart, LineChart, PieChart, ScatterChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { type EChartsCoreOption, init, use } from "echarts/core";
import { SVGRenderer } from "echarts/renderers";

import { card, cssVar, h, onThemeChange, start, t } from "../runtime.ts";

use([
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  SVGRenderer,
]);

interface Chart {
  readonly title: string;
  readonly type: "line" | "bar" | "scatter" | "pie";
  readonly labels?: ReadonlyArray<string>;
  readonly series: ReadonlyArray<{
    readonly name: string;
    readonly values?: ReadonlyArray<number | null>;
    readonly points?: ReadonlyArray<ReadonlyArray<number>>;
  }>;
  readonly xLabel?: string;
  readonly yLabel?: string;
}

const PALETTE = ["#0d9488", "#d97706", "#9333ea", "#e11d48", "#65a30d", "#0284c7", "#78716c"];

const optionsFor = (chart: Chart): EChartsCoreOption => {
  const text = cssVar("--text") || "#1c1b19";
  const soft = cssVar("--soft") || "#66635c";
  const line = cssVar("--line") || "#e6e3dc";
  const axis = {
    axisLabel: { color: soft },
    axisLine: { lineStyle: { color: line } },
    splitLine: { lineStyle: { color: line } },
    nameTextStyle: { color: soft },
  };
  const shared = {
    animationDuration: 200,
    color: [cssVar("--accent") || "#3552d1", ...PALETTE],
    textStyle: { fontFamily: cssVar("--font-sans") || "system-ui", color: text },
    tooltip: {
      trigger: chart.type === "line" || chart.type === "bar" ? "axis" : "item",
      backgroundColor: cssVar("--surface") || "#fff",
      borderColor: line,
      textStyle: { color: text },
      confine: true,
    },
    ...(chart.series.length > 1 || chart.type === "pie"
      ? { legend: { bottom: 0, type: "scroll", textStyle: { color: soft } } }
      : {}),
  };
  if (chart.type === "pie") {
    const [first] = chart.series;
    return {
      ...shared,
      series: [
        {
          type: "pie",
          radius: ["42%", "70%"],
          center: ["50%", "45%"],
          label: { color: text },
          data: (chart.labels ?? []).map((name, at) => ({ name, value: first?.values?.[at] ?? 0 })),
        },
      ],
    };
  }
  return {
    ...shared,
    grid: {
      left: 8,
      right: 16,
      top: 24,
      bottom: chart.series.length > 1 ? 40 : 24,
      containLabel: true,
    },
    xAxis:
      chart.type === "scatter"
        ? { type: "value", scale: true, name: chart.xLabel, ...axis }
        : { type: "category", data: chart.labels, name: chart.xLabel, ...axis },
    yAxis: { type: "value", scale: chart.type !== "bar", name: chart.yLabel, ...axis },
    series: chart.series.map((series) => ({
      type: chart.type,
      name: series.name,
      data: chart.type === "scatter" ? series.points : series.values,
      ...(chart.type === "line" ? { smooth: false, symbolSize: 6, lineStyle: { width: 2.5 } } : {}),
      ...(chart.type === "bar" ? { itemStyle: { borderRadius: [4, 4, 0, 0] } } : {}),
    })),
  };
};

void start<Chart>((chart, root) => {
  const plot = h("div", { class: "plot", role: "img", ariaLabel: chart.title });
  root.append(
    card(chart.title, [plot], { ask: `${t("About the chart", "O wykresie")} "${chart.title}": ` }),
  );
  const instance = init(plot, null, { renderer: "svg" });
  const draw = () => {
    instance.setOption(optionsFor(chart), true);
    instance.resize();
  };
  draw();
  onThemeChange(draw);
  new ResizeObserver(() => instance.resize()).observe(plot);
});
