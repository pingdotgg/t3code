/**
 * Writes the History at scale charts as standalone SVGs (light, or dark when
 * the viewer prefers it) to `public/domain/backfill/`, for places that can't
 * inline them, like pull requests. The docs page renders them inline.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { backfillCharts } from "../src/components/charts/backfillCharts.ts";
import { chartCss, renderLineChart } from "../src/components/charts/lineChart.ts";

const light = chartCss({
  surface: "#fbf6ea",
  text: "#2a2620",
  muted: "#52442e",
  grid: "rgba(42,38,32,0.14)",
  series: ["#2a78d6", "#eb6834", "#1baf7a"],
});
const dark = chartCss({
  surface: "#221e18",
  text: "#faf6ec",
  muted: "#c0af89",
  grid: "rgba(250,246,236,0.14)",
  series: ["#3987e5", "#d95926", "#199e70"],
});

const dir = new URL("../public/domain/backfill/", import.meta.url);
mkdirSync(dir, { recursive: true });
for (const [name, spec] of Object.entries(backfillCharts)) {
  const file = name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  const svg = renderLineChart(spec).replace(
    /^(<svg[^>]*>)/,
    `$1<style>${light}@media (prefers-color-scheme: dark){${dark}}</style>`,
  );
  writeFileSync(new URL(`${file}.svg`, dir), svg);
  console.log(`public/domain/backfill/${file}.svg`);
}
