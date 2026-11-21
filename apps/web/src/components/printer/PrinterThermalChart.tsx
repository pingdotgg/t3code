import type { PrinterThermalPoint } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useId, useState } from "react";

import { formatTemp } from "./printerFormat";

interface PrinterThermalChartProps {
  readonly history: ReadonlyArray<PrinterThermalPoint>;
  readonly showChamber: boolean;
}

function buildCoords(
  points: ReadonlyArray<PrinterThermalPoint>,
  getter: (point: PrinterThermalPoint) => number | null | undefined,
  minTemp: number,
  maxTemp: number,
): ReadonlyArray<readonly [number, number]> {
  const span = Math.max(10, maxTemp - minTemp);
  const count = Math.max(1, points.length - 1);
  const coords: Array<readonly [number, number]> = [];

  for (let i = 0; i < points.length; i++) {
    const val = getter(points[i]!);
    if (val === null || val === undefined || !Number.isFinite(val)) continue;
    const x = points.length === 1 ? 100 : (i / count) * 100;
    const ratio = Math.max(0, Math.min(1, (val - minTemp) / span));
    const y = 6 + (1 - ratio) * 88;
    coords.push([x, y]);
  }
  return coords;
}

function polylineString(coords: ReadonlyArray<readonly [number, number]>): string {
  return coords.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
}

function areaPath(coords: ReadonlyArray<readonly [number, number]>): string {
  if (coords.length < 2) return "";
  const first = coords[0]!;
  const last = coords.at(-1)!;
  const line = coords.map(([x, y]) => `L ${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
  return `M ${first[0].toFixed(2)} 94 ${line} L ${last[0].toFixed(2)} 94 Z`;
}

export function PrinterThermalChart({ history, showChamber }: PrinterThermalChartProps) {
  const gt = useGT();
  const idPrefix = useId();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (history.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center rounded-lg border border-border/60 bg-muted/20 text-xs text-muted-foreground">
        {gt("Collecting thermal telemetry...")}
      </div>
    );
  }

  let rawMax = 80;
  for (const point of history) {
    for (const candidate of [
      point.nozzleActualC,
      point.nozzleTargetC,
      point.bedActualC,
      point.bedTargetC,
      point.chamberActualC,
    ]) {
      if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > rawMax) {
        rawMax = candidate;
      }
    }
  }
  const maxTemp = Math.ceil((rawMax + 20) / 50) * 50;
  const minTemp = 0;

  const nozzleActual = buildCoords(history, (p) => p.nozzleActualC, minTemp, maxTemp);
  const nozzleTarget = buildCoords(history, (p) => p.nozzleTargetC, minTemp, maxTemp);
  const bedActual = buildCoords(history, (p) => p.bedActualC, minTemp, maxTemp);
  const bedTarget = buildCoords(history, (p) => p.bedTargetC, minTemp, maxTemp);
  const chamberActual = showChamber
    ? buildCoords(history, (p) => p.chamberActualC, minTemp, maxTemp)
    : [];

  const yTicks = [maxTemp, Math.round(maxTemp / 2), 0];
  const activePoint =
    hoverIndex !== null && history[hoverIndex] ? history[hoverIndex] : history.at(-1);
  const hoverPct =
    hoverIndex !== null && history.length > 1 ? (hoverIndex / (history.length - 1)) * 100 : null;

  const nozzleGradId = `${idPrefix}-nozzle-fill`;
  const bedGradId = `${idPrefix}-bed-fill`;

  return (
    <div className="rounded-lg border border-border/60 bg-card/60 p-2.5">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-2xs">
        <span className="font-medium text-muted-foreground">{gt("Thermal history")}</span>
        <div className="flex items-center gap-3 tabular-nums">
          <span className="inline-flex items-center gap-1 text-foreground">
            <span className="size-1.5 rounded-full bg-destructive" />
            {gt("Nozzle")} {formatTemp(activePoint?.nozzleActualC)}
          </span>
          <span className="inline-flex items-center gap-1 text-foreground">
            <span className="size-1.5 rounded-full bg-warning" />
            {gt("Bed")} {formatTemp(activePoint?.bedActualC)}
          </span>
          {showChamber ? (
            <span className="inline-flex items-center gap-1 text-foreground">
              <span className="size-1.5 rounded-full bg-info" />
              {gt("Chamber")} {formatTemp(activePoint?.chamberActualC)}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex items-stretch gap-2">
        {/* Fixed-width unstretched Y-axis labels */}
        <div className="flex w-7 shrink-0 flex-col justify-between py-0.5 text-right text-3xs leading-none text-muted-foreground tabular-nums">
          {yTicks.map((tick) => (
            <span key={tick}>{tick}°</span>
          ))}
        </div>

        {/* Full-bleed edge-to-edge plot area */}
        <div className="relative h-24 min-w-0 flex-1">
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="size-full select-none overflow-visible"
            role="img"
            aria-label={gt("Nozzle and bed temperature history chart")}
            onMouseLeave={() => setHoverIndex(null)}
            onMouseMove={(event) => {
              if (history.length <= 1) return;
              const rect = event.currentTarget.getBoundingClientRect();
              const norm = Math.max(
                0,
                Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)),
              );
              setHoverIndex(Math.round(norm * (history.length - 1)));
            }}
          >
            <defs>
              <linearGradient id={nozzleGradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--destructive)" stopOpacity={0.22} />
                <stop offset="100%" stopColor="var(--destructive)" stopOpacity={0} />
              </linearGradient>
              <linearGradient id={bedGradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--warning)" stopOpacity={0.18} />
                <stop offset="100%" stopColor="var(--warning)" stopOpacity={0} />
              </linearGradient>
            </defs>

            {[6, 50, 94].map((y) => (
              <line
                key={y}
                x1={0}
                x2={100}
                y1={y}
                y2={y}
                stroke="var(--border)"
                strokeOpacity={0.55}
                strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {bedActual.length >= 2 ? (
              <path d={areaPath(bedActual)} fill={`url(#${bedGradId})`} />
            ) : null}
            {nozzleActual.length >= 2 ? (
              <path d={areaPath(nozzleActual)} fill={`url(#${nozzleGradId})`} />
            ) : null}

            {nozzleTarget.length > 0 ? (
              <polyline
                fill="none"
                stroke="var(--destructive)"
                strokeOpacity={0.45}
                strokeWidth={1.25}
                strokeDasharray="4 3"
                vectorEffect="non-scaling-stroke"
                points={polylineString(nozzleTarget)}
              />
            ) : null}

            {bedTarget.length > 0 ? (
              <polyline
                fill="none"
                stroke="var(--warning)"
                strokeOpacity={0.45}
                strokeWidth={1.25}
                strokeDasharray="4 3"
                vectorEffect="non-scaling-stroke"
                points={polylineString(bedTarget)}
              />
            ) : null}

            {chamberActual.length === 1 ? (
              <line
                x1={0}
                x2={100}
                y1={chamberActual[0]![1]}
                y2={chamberActual[0]![1]}
                stroke="var(--info)"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
              />
            ) : chamberActual.length > 1 ? (
              <polyline
                fill="none"
                stroke="var(--info)"
                strokeWidth={1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                points={polylineString(chamberActual)}
              />
            ) : null}

            {bedActual.length === 1 ? (
              <line
                x1={0}
                x2={100}
                y1={bedActual[0]![1]}
                y2={bedActual[0]![1]}
                stroke="var(--warning)"
                strokeWidth={1.75}
                vectorEffect="non-scaling-stroke"
              />
            ) : bedActual.length > 1 ? (
              <polyline
                fill="none"
                stroke="var(--warning)"
                strokeWidth={1.75}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                points={polylineString(bedActual)}
              />
            ) : null}

            {nozzleActual.length === 1 ? (
              <line
                x1={0}
                x2={100}
                y1={nozzleActual[0]![1]}
                y2={nozzleActual[0]![1]}
                stroke="var(--destructive)"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            ) : nozzleActual.length > 1 ? (
              <polyline
                fill="none"
                stroke="var(--destructive)"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                points={polylineString(nozzleActual)}
              />
            ) : null}

            {hoverPct !== null ? (
              <line
                x1={hoverPct}
                x2={hoverPct}
                y1={4}
                y2={96}
                stroke="var(--muted-foreground)"
                strokeOpacity={0.5}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
          </svg>
        </div>
      </div>
    </div>
  );
}
