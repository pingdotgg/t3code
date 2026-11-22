import type {
  ElectronicsCircuitModel,
  ElectronicsSimulationKind,
  ElectronicsSimulationResult,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { ActivityIcon, PlayIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";

export interface SimulationPanelProps {
  readonly model: ElectronicsCircuitModel;
  readonly kind: ElectronicsSimulationKind;
  readonly outputNode: string;
  readonly running: boolean;
  readonly error: string | null;
  readonly result: ElectronicsSimulationResult | null;
  readonly onChangeKind: (kind: ElectronicsSimulationKind) => void;
  readonly onChangeOutputNode: (node: string) => void;
  readonly onRunSimulate: () => void;
}

const TRACE_COLORS = [
  "var(--chart-1, #38bdf8)",
  "var(--chart-2, #10b981)",
  "var(--chart-3, #f59e0b)",
  "var(--chart-4, #a855f7)",
];

function formatAxisTick(value: number, unit: string): string {
  if (unit === "Hz") {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
    return `${value.toFixed(0)}`;
  }
  return Number(value.toPrecision(3)).toString();
}

function formatEngineering(value: number, unit: string): string {
  const abs = Math.abs(value);
  if (abs === 0) return `0 ${unit}`;
  if (abs >= 1e6) return `${(value / 1e6).toPrecision(3)} M${unit}`;
  if (abs >= 1e3) return `${(value / 1e3).toPrecision(3)} k${unit}`;
  if (abs >= 1) return `${value.toPrecision(4)} ${unit}`;
  if (abs >= 1e-3) return `${(value * 1e3).toPrecision(3)} m${unit}`;
  if (abs >= 1e-6) return `${(value * 1e6).toPrecision(3)} µ${unit}`;
  return `${value.toExponential(2)} ${unit}`;
}

export function SimulationPanel(props: SimulationPanelProps) {
  const {
    model,
    kind,
    outputNode,
    running,
    error,
    result,
    onChangeKind,
    onChangeOutputNode,
    onRunSimulate,
  } = props;
  const gt = useGT();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const nonGroundNets = model.nets.filter((n) => !n.isGround);

  const chartW = 540;
  const chartH = 210;
  const padL = 48;
  const padR = 16;
  const padT = 16;
  const padB = 28;
  const plotW = chartW - padL - padR;
  const plotH = chartH - padT - padB;

  const series = result?.series ?? [];
  const allPoints = series.flatMap((s) => s.points);
  const xLog = result?.xAxisLog ?? false;

  let xMin = 0;
  let xMax = 1;
  let rawYMin = 0;
  let rawYMax = 1;
  if (allPoints.length > 0) {
    xMin = Infinity;
    xMax = -Infinity;
    rawYMin = Infinity;
    rawYMax = -Infinity;
    for (const p of allPoints) {
      if (p.x < xMin) xMin = p.x;
      if (p.x > xMax) xMax = p.x;
      if (p.y < rawYMin) rawYMin = p.y;
      if (p.y > rawYMax) rawYMax = p.y;
    }
  }
  const ySpan = Math.max(1e-6, rawYMax - rawYMin);
  const yMin = rawYMin - ySpan * 0.08;
  const yMax = rawYMax + ySpan * 0.08;

  const mapX = (x: number): number => {
    if (xLog && xMin > 0 && xMax > xMin) {
      const frac =
        (Math.log10(Math.max(xMin, x)) - Math.log10(xMin)) / (Math.log10(xMax) - Math.log10(xMin));
      return padL + frac * plotW;
    }
    const span = Math.max(1e-9, xMax - xMin);
    return padL + ((x - xMin) / span) * plotW;
  };
  const mapY = (y: number): number => padT + (1 - (y - yMin) / Math.max(1e-9, yMax - yMin)) * plotH;

  const primarySeries = series[0];
  const hoveredPoint =
    hoverIdx !== null && primarySeries ? (primarySeries.points[hoverIdx] ?? null) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 text-xs">
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-card/60 p-3">
        <label className="flex flex-col gap-1">
          <span className="text-2xs text-muted-foreground">
            <T>Analysis</T>
          </span>
          <select
            value={kind}
            onChange={(e) => onChangeKind(e.target.value as ElectronicsSimulationKind)}
            className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
          >
            <option value="dc_op">{gt("DC Operating Point")}</option>
            <option value="ac_sweep">{gt("AC Frequency Sweep (Bode)")}</option>
            <option value="transient">{gt("Transient Step Response")}</option>
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-2xs text-muted-foreground">
            <T>Probe Node</T>
          </span>
          <select
            value={outputNode}
            onChange={(e) => onChangeOutputNode(e.target.value)}
            className="h-8 rounded-md border border-border bg-background px-2 font-mono text-xs text-foreground"
          >
            <option value="">{gt("Auto")}</option>
            {nonGroundNets.map((n) => (
              <option key={n.name} value={n.name}>
                {n.name}
              </option>
            ))}
          </select>
        </label>

        <div className="ml-auto">
          <Button size="sm" disabled={running} onClick={onRunSimulate}>
            <PlayIcon className="mr-1 size-3.5" />
            {running ? <T>Simulating…</T> : <T>Run Simulation</T>}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {result && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-border bg-muted/60 px-2 py-0.5 font-mono text-3xs text-muted-foreground">
              {result.engine === "ngspice" ? gt("ngspice") : gt("Built-in MNA Solver")}
            </span>
            {result.metrics.map((metric) => (
              <div
                key={metric.name}
                className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1"
              >
                <span className="text-muted-foreground">{metric.name}:</span>
                <span className="font-mono font-semibold text-foreground">
                  {formatEngineering(metric.value, metric.unit)}
                </span>
              </div>
            ))}
          </div>

          {series.length > 0 && (
            <div className="rounded-lg border border-border bg-card/50 p-2.5">
              <div className="mb-1.5 flex items-center justify-between text-2xs">
                <div className="flex items-center gap-2">
                  <ActivityIcon className="size-3.5 text-primary" />
                  {series.map((s, idx) => (
                    <span key={s.label} className="flex items-center gap-1 font-mono">
                      <span
                        className="inline-block size-2 rounded-full"
                        style={{ backgroundColor: TRACE_COLORS[idx % TRACE_COLORS.length] }}
                      />
                      {s.label} ({s.unit})
                    </span>
                  ))}
                </div>
                {hoveredPoint && (
                  <span className="font-mono text-muted-foreground">
                    {formatAxisTick(hoveredPoint.x, result.xAxisUnit)} {result.xAxisUnit} ·{" "}
                    {hoveredPoint.y.toFixed(2)} {primarySeries?.unit}
                    {hoveredPoint.phaseDeg !== undefined ? ` · ${hoveredPoint.phaseDeg}°` : ""}
                  </span>
                )}
              </div>

              <svg
                viewBox={`0 0 ${chartW} ${chartH}`}
                className="h-52 w-full select-none"
                onMouseLeave={() => setHoverIdx(null)}
                onMouseMove={(e) => {
                  if (!primarySeries || primarySeries.points.length === 0) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const relX = ((e.clientX - rect.left) / Math.max(1, rect.width)) * chartW;
                  const frac = Math.max(0, Math.min(1, (relX - padL) / plotW));
                  const idx = Math.round(frac * (primarySeries.points.length - 1));
                  setHoverIdx(idx);
                }}
              >
                {[0, 0.25, 0.5, 0.75, 1].map((f) => {
                  const yVal = yMin + f * (yMax - yMin);
                  const yPos = mapY(yVal);
                  return (
                    <g key={`gy-${f}`}>
                      <line
                        x1={padL}
                        y1={yPos}
                        x2={chartW - padR}
                        y2={yPos}
                        stroke="var(--border)"
                        strokeDasharray="2 3"
                      />
                      <text
                        x={padL - 6}
                        y={yPos + 3}
                        textAnchor="end"
                        fontSize={9}
                        fill="var(--muted-foreground)"
                        fontFamily="var(--font-mono, monospace)"
                      >
                        {yVal.toFixed(1)}
                      </text>
                    </g>
                  );
                })}

                {[0, 0.25, 0.5, 0.75, 1].map((f) => {
                  const xVal =
                    xLog && xMin > 0 ? xMin * Math.pow(xMax / xMin, f) : xMin + f * (xMax - xMin);
                  const xPos = padL + f * plotW;
                  return (
                    <text
                      key={`gx-${f}`}
                      x={xPos}
                      y={chartH - 8}
                      textAnchor="middle"
                      fontSize={9}
                      fill="var(--muted-foreground)"
                      fontFamily="var(--font-mono, monospace)"
                    >
                      {formatAxisTick(xVal, result.xAxisUnit)}
                    </text>
                  );
                })}

                {series.map((s, idx) => {
                  const pts = s.points
                    .map((p) => `${mapX(p.x).toFixed(1)},${mapY(p.y).toFixed(1)}`)
                    .join(" ");
                  return (
                    <polyline
                      key={s.label}
                      fill="none"
                      stroke={TRACE_COLORS[idx % TRACE_COLORS.length]}
                      strokeWidth={2}
                      points={pts}
                    />
                  );
                })}

                {hoveredPoint && (
                  <g>
                    <line
                      x1={mapX(hoveredPoint.x)}
                      y1={padT}
                      x2={mapX(hoveredPoint.x)}
                      y2={chartH - padB}
                      stroke="var(--muted-foreground)"
                      strokeDasharray="2 2"
                    />
                    <circle
                      cx={mapX(hoveredPoint.x)}
                      cy={mapY(hoveredPoint.y)}
                      r={3.5}
                      fill={TRACE_COLORS[0]}
                      stroke="var(--background)"
                      strokeWidth={1.5}
                    />
                  </g>
                )}
              </svg>
            </div>
          )}

          {result.nodeVoltages.length > 0 && (
            <div className="rounded-lg border border-border bg-card/40 p-2.5">
              <div className="mb-1.5 font-medium text-foreground">
                <T>DC Node Voltages</T>
              </div>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {result.nodeVoltages.map((nv) => (
                  <div
                    key={nv.node}
                    className="flex items-center justify-between rounded border border-border/60 bg-background px-2 py-1 font-mono text-2xs"
                  >
                    <span className="text-muted-foreground">{nv.node}</span>
                    <span className="font-semibold text-foreground">
                      {nv.voltageV.toFixed(4)} V
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {result.componentReadings.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full border-collapse text-left text-2xs">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="px-2.5 py-1.5 font-medium">
                      <T>Ref</T>
                    </th>
                    <th className="px-2.5 py-1.5 font-medium">
                      <T>Value</T>
                    </th>
                    <th className="px-2.5 py-1.5 text-right font-medium">
                      <T>ΔV</T>
                    </th>
                    <th className="px-2.5 py-1.5 text-right font-medium">
                      <T>Current</T>
                    </th>
                    <th className="px-2.5 py-1.5 text-right font-medium">
                      <T>Power</T>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60 font-mono">
                  {result.componentReadings.map((row) => (
                    <tr key={row.ref}>
                      <td className="px-2.5 py-1 font-semibold text-foreground">{row.ref}</td>
                      <td className="px-2.5 py-1 text-muted-foreground">{row.value}</td>
                      <td className="px-2.5 py-1 text-right">{row.voltageDropV.toFixed(3)} V</td>
                      <td className="px-2.5 py-1 text-right">
                        {formatEngineering(row.currentA, "A")}
                      </td>
                      <td className="px-2.5 py-1 text-right">
                        {formatEngineering(row.powerW, "W")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {result.notes.length > 0 && (
            <div className="text-2xs text-muted-foreground">
              {result.notes.map((n) => (
                <p key={n}>{n}</p>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
