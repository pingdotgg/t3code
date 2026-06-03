import type { NeuropharmGraphSpec } from "@t3tools/contracts";
import { Fragment, memo, useMemo } from "react";

import { Badge } from "../ui/badge";
import { cn } from "../../lib/utils";

const MAX_BAR_VALUE = 100;
const NETWORK_COLUMNS = 4;
const RADAR_SIZE = 220;
const RADAR_CENTER = RADAR_SIZE / 2;
const RADAR_RADIUS = 82;

function evidenceTone(unit: string | undefined) {
  const normalized = unit?.toLowerCase();
  if (normalized === "measured") {
    return {
      node: "border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-700/70 dark:bg-emerald-950/25 dark:text-emerald-100",
      line: "bg-emerald-500",
      badge: "success" as const,
    };
  }
  if (normalized === "inferred") {
    return {
      node: "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-700/70 dark:bg-amber-950/25 dark:text-amber-100",
      line: "bg-amber-500",
      badge: "warning" as const,
    };
  }
  return {
    node: "border-border/70 bg-background text-foreground",
    line: "bg-muted-foreground/45",
    badge: "outline" as const,
  };
}

const TargetNetworkRenderer = memo(function TargetNetworkRenderer(props: {
  spec: NeuropharmGraphSpec;
  className?: string;
}) {
  const data = useMemo(() => props.spec.data.slice(0, 80), [props.spec.data]);
  const groups = useMemo(
    () => [...new Set(data.map((datum) => datum.group?.trim()).filter(Boolean))] as string[],
    [data],
  );
  const sourceLabels = groups.length > 0 ? groups : ["Evidence"];

  return (
    <div
      className={cn(
        "my-3 rounded-md border border-border bg-card/70 p-3 text-card-foreground",
        props.className,
      )}
    >
      <div className="mb-4 flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{props.spec.title}</div>
          <div className="text-xs text-muted-foreground">
            Receptor binding strengths by evidence grade
          </div>
        </div>
        <Badge variant="outline" className="uppercase">
          TARGET NETWORK
        </Badge>
      </div>

      <div className="overflow-x-auto pb-1">
        <div className="grid min-w-[44rem] grid-cols-[12rem_1fr] gap-4">
          <div className="space-y-2">
            {sourceLabels.map((label) => (
              <div
                key={label}
                className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-xs font-medium text-sky-950 dark:border-sky-700/70 dark:bg-sky-950/25 dark:text-sky-100"
              >
                <div className="truncate" title={label}>
                  {label}
                </div>
                <div className="mt-1 text-[10px] uppercase text-sky-800/70 dark:text-sky-200/65">
                  source
                </div>
              </div>
            ))}
          </div>

          <div
            className="grid gap-2"
            style={{ gridTemplateColumns: `repeat(${NETWORK_COLUMNS}, minmax(8rem, 1fr))` }}
          >
            {data.map((datum) => {
              const tone = evidenceTone(datum.unit);
              const strength = Math.max(0, Math.min(MAX_BAR_VALUE, datum.value));
              return (
                <div
                  key={`${datum.group ?? "target"}:${datum.label}:${datum.unit ?? "score"}:${datum.value}`}
                  className={cn("min-w-0 rounded-md border px-3 py-2 text-xs", tone.node)}
                >
                  <div className="truncate font-medium" title={datum.label}>
                    {datum.label}
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <Badge variant={tone.badge} className="h-5 px-1.5 text-[10px]">
                      {datum.unit ?? "score"}
                    </Badge>
                    <span className="tabular-nums text-muted-foreground">{strength}</span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-sm bg-background/70">
                    <div
                      className={cn("h-full rounded-sm", tone.line)}
                      style={{ width: `${strength}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {props.spec.notes.length > 0 ? (
        <div className="mt-3 space-y-1 border-t border-border/70 pt-2 text-xs text-muted-foreground">
          {props.spec.notes.map((note) => (
            <div key={note}>{note}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
});

function clampScore(value: number) {
  return Math.max(0, Math.min(MAX_BAR_VALUE, value));
}

function groupedData(spec: NeuropharmGraphSpec) {
  const groups = new Map<string, typeof spec.data>();
  for (const datum of spec.data) {
    const key = datum.group?.trim() || "Series";
    groups.set(key, [...(groups.get(key) ?? []), datum]);
  }
  return [...groups.entries()];
}

const RadarGraphRenderer = memo(function RadarGraphRenderer(props: {
  spec: NeuropharmGraphSpec;
  className?: string;
}) {
  const data = useMemo(() => props.spec.data.slice(0, 120), [props.spec.data]);
  const axes = useMemo(() => [...new Set(data.map((datum) => datum.label))].slice(0, 10), [data]);
  const groups = useMemo(
    () => groupedData({ ...props.spec, data }).slice(0, 3),
    [data, props.spec],
  );
  const palette = ["#10b981", "#0ea5e9", "#f59e0b"] as const;
  const rings = [25, 50, 75, 100];

  const pointFor = (axisIndex: number, value: number) => {
    const angle = (Math.PI * 2 * axisIndex) / Math.max(axes.length, 1) - Math.PI / 2;
    const radius = (clampScore(value) / MAX_BAR_VALUE) * RADAR_RADIUS;
    return {
      x: RADAR_CENTER + Math.cos(angle) * radius,
      y: RADAR_CENTER + Math.sin(angle) * radius,
    };
  };

  return (
    <div
      className={cn(
        "my-3 rounded-md border border-border bg-card/70 p-3 text-card-foreground",
        props.className,
      )}
    >
      <div className="mb-4 flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{props.spec.title}</div>
          <div className="text-xs text-muted-foreground">Normalized selectivity profile</div>
        </div>
        <Badge variant="outline" className="uppercase">
          {props.spec.kind === "receptor_selectivity_radar"
            ? "SELECTIVITY PROFILE"
            : "ADMET PROFILE"}
        </Badge>
      </div>
      <div className="grid gap-3 md:grid-cols-[15rem_1fr]">
        <div className="rounded-md border border-border/70 bg-background/70 p-2">
          <svg
            role="img"
            aria-label={`${props.spec.title} radar chart`}
            viewBox={`0 0 ${RADAR_SIZE} ${RADAR_SIZE}`}
            className="mx-auto aspect-square w-full max-w-[14rem]"
          >
            {rings.map((ring) => (
              <circle
                key={ring}
                cx={RADAR_CENTER}
                cy={RADAR_CENTER}
                r={(ring / MAX_BAR_VALUE) * RADAR_RADIUS}
                fill="none"
                stroke="currentColor"
                className="text-border"
                strokeWidth="1"
              />
            ))}
            {axes.map((axis, index) => {
              const outer = pointFor(index, MAX_BAR_VALUE);
              return (
                <line
                  key={axis}
                  x1={RADAR_CENTER}
                  y1={RADAR_CENTER}
                  x2={outer.x}
                  y2={outer.y}
                  stroke="currentColor"
                  className="text-border"
                  strokeWidth="1"
                />
              );
            })}
            {groups.map(([group, values], groupIndex) => {
              const points = axes.map((axis, axisIndex) => {
                const datum = values.find((entry) => entry.label === axis);
                return pointFor(axisIndex, datum?.value ?? 0);
              });
              const polygon = points.map((point) => `${point.x},${point.y}`).join(" ");
              return (
                <polygon
                  key={group}
                  points={polygon}
                  fill={palette[groupIndex]}
                  fillOpacity="0.16"
                  stroke={palette[groupIndex]}
                  strokeWidth="2"
                />
              );
            })}
          </svg>
        </div>
        <div className="space-y-2">
          {axes.map((axis) => (
            <div key={axis} className="grid grid-cols-[8rem_1fr] items-center gap-2 text-xs">
              <span className="truncate text-muted-foreground" title={axis}>
                {axis}
              </span>
              <div className="flex flex-wrap gap-1">
                {groups.map(([group, values], groupIndex) => {
                  const datum = values.find((entry) => entry.label === axis);
                  return (
                    <Badge
                      key={`${group}:${axis}`}
                      variant="outline"
                      className="gap-1 text-[10px]"
                      title={`${group}: ${datum?.value ?? 0}`}
                    >
                      <span
                        className="size-2 rounded-sm"
                        style={{ backgroundColor: palette[groupIndex] }}
                      />
                      {group} {datum?.value ?? 0}
                    </Badge>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      {props.spec.notes.length > 0 ? (
        <div className="mt-3 space-y-1 border-t border-border/70 pt-2 text-xs text-muted-foreground">
          {props.spec.notes.map((note) => (
            <div key={note}>{note}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
});

const HeatmapGraphRenderer = memo(function HeatmapGraphRenderer(props: {
  spec: NeuropharmGraphSpec;
  className?: string;
}) {
  const data = useMemo(() => props.spec.data.slice(0, 160), [props.spec.data]);
  const rows = useMemo(
    () => [...new Set(data.map((datum) => datum.group?.trim() || "Score"))].slice(0, 16),
    [data],
  );
  const columns = useMemo(
    () => [...new Set(data.map((datum) => datum.label))].slice(0, 16),
    [data],
  );
  const valuesByCell = useMemo(() => {
    const values = new Map<string, (typeof data)[number]>();
    for (const datum of data) {
      values.set(`${datum.group?.trim() || "Score"}\u0000${datum.label}`, datum);
    }
    return values;
  }, [data]);
  const valueFor = (row: string, column: string) => valuesByCell.get(`${row}\u0000${column}`);

  return (
    <div
      className={cn(
        "my-3 rounded-md border border-border bg-card/70 p-3 text-card-foreground",
        props.className,
      )}
    >
      <div className="mb-4 flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{props.spec.title}</div>
          <div className="text-xs text-muted-foreground">Risk matrix (0-100 scale)</div>
        </div>
        <Badge variant="outline" className="uppercase">
          {props.spec.kind === "interaction_risk_heatmap"
            ? "INTERACTION RISKS"
            : "COGNITIVE DOMAINS"}
        </Badge>
      </div>
      <div className="overflow-x-auto">
        <div
          className="grid min-w-[36rem] gap-1 text-xs"
          style={{ gridTemplateColumns: `9rem repeat(${columns.length}, minmax(6rem, 1fr))` }}
        >
          <div />
          {columns.map((column) => (
            <div key={column} className="truncate px-2 py-1 text-center text-muted-foreground">
              {column}
            </div>
          ))}
          {rows.map((row) => (
            <Fragment key={row}>
              <div className="truncate px-2 py-2 font-medium" title={row}>
                {row}
              </div>
              {columns.map((column) => {
                const datum = valueFor(row, column);
                const value = clampScore(datum?.value ?? 0);
                return (
                  <div
                    key={`${row}:${column}`}
                    className="rounded-sm border border-border/60 px-2 py-2 text-center tabular-nums"
                    title={datum ? `${row} / ${column}: ${value} ${datum.unit ?? ""}` : undefined}
                    style={{
                      backgroundColor: `color-mix(in srgb, rgb(16 185 129) ${value}%, transparent)`,
                    }}
                  >
                    {datum ? value : "-"}
                  </div>
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>
      {props.spec.notes.length > 0 ? (
        <div className="mt-3 space-y-1 border-t border-border/70 pt-2 text-xs text-muted-foreground">
          {props.spec.notes.map((note) => (
            <div key={note}>{note}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
});

const TimelineGraphRenderer = memo(function TimelineGraphRenderer(props: {
  spec: NeuropharmGraphSpec;
  className?: string;
}) {
  const data = useMemo(() => props.spec.data.slice(0, 48), [props.spec.data]);
  const maxValue = useMemo(() => Math.max(...data.map((datum) => datum.value), 1), [data]);

  return (
    <div
      className={cn(
        "my-3 rounded-md border border-border bg-card/70 p-3 text-card-foreground",
        props.className,
      )}
    >
      <div className="mb-4 flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{props.spec.title}</div>
          <div className="text-xs text-muted-foreground">Pharmacokinetic profile</div>
        </div>
        <Badge variant="outline" className="uppercase">
          PK TIMELINE
        </Badge>
      </div>
      <div className="overflow-x-auto pb-1">
        <div className="grid min-w-[34rem] grid-flow-col auto-cols-fr items-end gap-2">
          {data.map((datum) => {
            const height = Math.max(8, Math.min(100, (datum.value / maxValue) * 100));
            return (
              <div
                key={`${datum.group ?? "timeline"}:${datum.label}:${datum.value}:${datum.unit ?? "score"}`}
                className="text-xs"
              >
                <div className="mb-2 flex h-28 items-end rounded-sm bg-muted/50 px-2">
                  <div
                    className="w-full rounded-t-sm bg-sky-500"
                    style={{ height: `${height}%` }}
                  />
                </div>
                <div className="truncate font-medium" title={datum.label}>
                  {datum.label}
                </div>
                <div className="truncate text-muted-foreground">
                  {datum.value}
                  {datum.unit ? ` ${datum.unit}` : ""}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {props.spec.notes.length > 0 ? (
        <div className="mt-3 space-y-1 border-t border-border/70 pt-2 text-xs text-muted-foreground">
          {props.spec.notes.map((note) => (
            <div key={note}>{note}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
});

export function ScientificGraphRenderer(props: { spec: NeuropharmGraphSpec; className?: string }) {
  if (props.spec.kind === "target_network") {
    return (
      <TargetNetworkRenderer
        spec={props.spec}
        {...(props.className ? { className: props.className } : {})}
      />
    );
  }
  if (props.spec.kind === "receptor_selectivity_radar" || props.spec.kind === "admet_radar") {
    return (
      <RadarGraphRenderer
        spec={props.spec}
        {...(props.className ? { className: props.className } : {})}
      />
    );
  }
  if (props.spec.kind === "interaction_risk_heatmap" || props.spec.kind === "task_domain_matrix") {
    return (
      <HeatmapGraphRenderer
        spec={props.spec}
        {...(props.className ? { className: props.className } : {})}
      />
    );
  }
  if (props.spec.kind === "pk_timeline") {
    return (
      <TimelineGraphRenderer
        spec={props.spec}
        {...(props.className ? { className: props.className } : {})}
      />
    );
  }

  const maxValue = Math.max(...props.spec.data.map((datum) => datum.value), 1);

  return (
    <div
      className={cn(
        "my-3 rounded-md border border-border bg-card/70 p-3 text-card-foreground",
        props.className,
      )}
    >
      <div className="mb-4 flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{props.spec.title}</div>
          <div className="text-xs text-muted-foreground">
            {props.spec.xLabel ?? "Domain"} / {props.spec.yLabel ?? "Relative score"}
          </div>
        </div>
        <Badge variant="outline" className="uppercase">
          {props.spec.kind.replaceAll("_", " ")}
        </Badge>
      </div>
      <div className="space-y-2">
        {props.spec.data.map((datum) => {
          const width = Math.max(4, Math.min(MAX_BAR_VALUE, (datum.value / maxValue) * 100));
          return (
            <div
              key={`${datum.group ?? "datum"}:${datum.label}`}
              className="grid grid-cols-[8rem_1fr_4rem] items-center gap-2 text-xs"
            >
              <span className="min-w-0 truncate text-muted-foreground">{datum.label}</span>
              <div className="h-2 overflow-hidden rounded-sm bg-muted">
                <div className="h-full rounded-sm bg-emerald-500" style={{ width: `${width}%` }} />
              </div>
              <span className="text-right tabular-nums">
                {datum.value}
                {datum.unit ? ` ${datum.unit}` : ""}
              </span>
            </div>
          );
        })}
      </div>
      {props.spec.notes.length > 0 ? (
        <div className="mt-3 space-y-1 border-t border-border/70 pt-2 text-xs text-muted-foreground">
          {props.spec.notes.map((note) => (
            <div key={note}>{note}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
