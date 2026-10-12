import { useAtomValue } from "@effect/atom-react";
import type { ModelBenchmarks, ProviderInstanceId } from "@t3tools/contracts";
import { ChartSplineIcon, ExternalLinkIcon } from "lucide-react";
import { memo, useMemo } from "react";

import { Button } from "../ui/button";
import { ComboboxItem } from "../ui/combobox";
import { Kbd } from "../ui/kbd";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { modelBenchmarksAtom } from "../../state/server";
import {
  formatCostPerTask,
  matchBenchmarkVariants,
  paretoFrontier,
  type ParetoPoint,
} from "./ModelPickerPareto.logic";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { getDisplayModelName } from "./providerIconUtils";

const pointName = (point: ParetoPoint) =>
  getDisplayModelName(point.model, { preferShortName: true });

export const ParetoListRow = memo(function ParetoListRow(props: {
  index: number;
  value: string;
  point: ParetoPoint;
  jumpLabel: string | null;
}) {
  const { entry, intelligence, costPerTask } = props.point;
  return (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={props.value}
      className="group relative w-full !min-w-0 max-w-full cursor-pointer"
    >
      <div className="min-w-0 flex-1 text-left">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="min-w-0 truncate text-xs font-medium leading-snug">
            {pointName(props.point)}
          </span>
          <span className="shrink-0 text-xs leading-snug text-muted-foreground">
            {props.point.effortLabel}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-1.5">
          <ProviderInstanceIcon
            driverKind={entry.driverKind}
            displayName={entry.displayName}
            acpRegistryAgentId={entry.acpRegistryAgentId}
            acpRegistryIconUrl={entry.acpRegistryIconUrl}
            className="size-3"
            iconClassName="size-3"
          />
          <span className="truncate text-xs leading-snug text-muted-foreground/70">
            {entry.displayName}
          </span>
        </div>
      </div>
      {props.jumpLabel ? <Kbd>{props.jumpLabel}</Kbd> : null}
      <div className="shrink-0 text-right text-xs leading-snug tabular-nums">
        <div className="font-medium">{intelligence.toFixed(1)}</div>
        <div className="mt-1 text-muted-foreground/70">{formatCostPerTask(costPerTask)}/task</div>
      </div>
    </ComboboxItem>
  );
});

function SlopalyticsLink(props: { benchmarks: ModelBenchmarks }) {
  return (
    <Button
      size="icon-xs"
      variant="ghost-muted"
      aria-label={`Open ${props.benchmarks.source}`}
      render={<a href={props.benchmarks.url} target="_blank" rel="noreferrer" />}
    >
      <ExternalLinkIcon />
    </Button>
  );
}

/** The user's benchmarked variants and their frontier, when the server sends scores. */
export function useParetoPoints(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  getModelDisabledReason:
    | ((instanceId: ProviderInstanceId, model: string) => string | null)
    | undefined,
  enabled: boolean,
) {
  const benchmarks = useAtomValue(modelBenchmarksAtom);
  const points = useMemo(
    () =>
      enabled && benchmarks
        ? matchBenchmarkVariants(entries, benchmarks.variants).filter(
            (point) => !getModelDisabledReason?.(point.entry.instanceId, point.model.slug),
          )
        : [],
    [benchmarks, enabled, entries, getModelDisabledReason],
  );
  const frontier = useMemo(() => paretoFrontier(points), [points]);
  return { benchmarks: enabled ? benchmarks : undefined, points, frontier };
}

const formatUpdatedAt = (benchmarks: ModelBenchmarks, options: Intl.DateTimeFormatOptions) => {
  const updated = new Date(benchmarks.updatedAt);
  return Number.isNaN(updated.getTime())
    ? benchmarks.updatedAt
    : updated.toLocaleDateString(undefined, options);
};

export function ParetoPanelHeader(props: {
  benchmarks: ModelBenchmarks;
  onOpenChart: (() => void) | undefined;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border/70 py-1.5 pr-2 pl-3">
      <div className="min-w-0 flex-1 leading-snug">
        <div className="truncate text-xs font-medium">Best value from your models</div>
        <div className="truncate text-xs text-muted-foreground/70">
          {props.benchmarks.source} score ·{" "}
          {formatUpdatedAt(props.benchmarks, { month: "short", day: "numeric" })}
        </div>
      </div>
      {props.onOpenChart ? (
        <Button size="xs" variant="ghost-muted" onClick={props.onOpenChart}>
          <ChartSplineIcon />
          Chart
        </Button>
      ) : null}
      <SlopalyticsLink benchmarks={props.benchmarks} />
    </div>
  );
}

/**
 * Opened from the picker after it closes: popovers stack above dialogs, so the
 * chart cannot open from inside one.
 */
export function ParetoChartDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: ReadonlyArray<ProviderInstanceEntry>;
  getModelDisabledReason:
    | ((instanceId: ProviderInstanceId, model: string) => string | null)
    | undefined;
}) {
  const { benchmarks, points, frontier } = useParetoPoints(
    props.entries,
    props.getModelDisabledReason,
    props.open,
  );
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {benchmarks ? (
        <DialogPopup className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Pareto line</DialogTitle>
            <DialogDescription>
              Coding intelligence against cost per task for the models you can run. The line joins
              the smartest model at each price. Data from {benchmarks.source},{" "}
              {formatUpdatedAt(benchmarks, { dateStyle: "medium" })}.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {points.length > 0 ? <ParetoChart points={points} frontier={frontier} /> : null}
            <a
              className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              href={benchmarks.url}
              target="_blank"
              rel="noreferrer"
            >
              Compare every model on {benchmarks.source}
              <ExternalLinkIcon className="size-3" />
            </a>
          </DialogPanel>
        </DialogPopup>
      ) : null}
    </Dialog>
  );
}

const CHART = { width: 600, height: 320, left: 40, right: 24, top: 16, bottom: 36 };
const COST_TICKS = [0.001, 0.003, 0.01, 0.03, 0.1, 0.3, 1, 3, 10, 30];

/** Log-cost x, linear intelligence y; the frontier is drawn over every match. */
function ParetoChart(props: {
  points: ReadonlyArray<ParetoPoint>;
  frontier: ReadonlyArray<ParetoPoint>;
}) {
  const costs = props.points.map((point) => Math.log10(point.costPerTask));
  const scores = props.points.map((point) => point.intelligence);
  const minLog = Math.min(...costs) - 0.15;
  const maxLog = Math.max(...costs) + 0.15;
  const minScore = Math.floor(Math.min(...scores) / 10) * 10;
  const maxScore = Math.ceil(Math.max(...scores) / 10) * 10;
  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  const x = (cost: number) =>
    CHART.left + ((Math.log10(cost) - minLog) / (maxLog - minLog || 1)) * plotWidth;
  const y = (score: number) =>
    CHART.top + plotHeight - ((score - minScore) / (maxScore - minScore || 1)) * plotHeight;
  const scoreTicks = Array.from(
    { length: (maxScore - minScore) / 10 + 1 },
    (_, index) => minScore + index * 10,
  );
  const costTicks = COST_TICKS.filter(
    (cost) => Math.log10(cost) >= minLog && Math.log10(cost) <= maxLog,
  );
  const frontierSet = new Set(props.frontier);
  const labelled = new Set<string>();
  const describe = (point: ParetoPoint) =>
    `${pointName(point)} ${point.effortLabel} (${point.entry.displayName}): ${point.intelligence.toFixed(1)}, ${formatCostPerTask(point.costPerTask)} per task`;

  return (
    <svg
      viewBox={`0 0 ${CHART.width} ${CHART.height}`}
      className="w-full text-2xs"
      role="img"
      aria-label="Intelligence against cost per task"
    >
      {scoreTicks.map((score) => (
        <g key={score}>
          <line
            x1={CHART.left}
            x2={CHART.width - CHART.right}
            y1={y(score)}
            y2={y(score)}
            className="stroke-border"
          />
          <text
            x={CHART.left - 6}
            y={y(score)}
            textAnchor="end"
            dominantBaseline="middle"
            className="fill-muted-foreground"
          >
            {score}
          </text>
        </g>
      ))}
      {costTicks.map((cost) => (
        <text
          key={cost}
          x={x(cost)}
          y={CHART.height - CHART.bottom + 16}
          textAnchor="middle"
          className="fill-muted-foreground"
        >
          ${cost}
        </text>
      ))}
      <text
        x={CHART.left + plotWidth / 2}
        y={CHART.height - 4}
        textAnchor="middle"
        className="fill-muted-foreground"
      >
        Cost per task (log scale)
      </text>
      {props.points
        .filter((point) => !frontierSet.has(point))
        .map((point) => (
          <circle
            key={`${point.entry.instanceId}:${point.model.slug}:${point.effortLabel}`}
            cx={x(point.costPerTask)}
            cy={y(point.intelligence)}
            r={3}
            className="fill-muted-foreground/40"
          >
            <title>{describe(point)}</title>
          </circle>
        ))}
      <polyline
        points={props.frontier
          .map((point) => `${x(point.costPerTask)},${y(point.intelligence)}`)
          .join(" ")}
        fill="none"
        strokeWidth={2}
        className="stroke-primary"
      />
      {props.frontier.map((point) => {
        // Label each model once, at its cheapest frontier point. The line rises
        // to the right, so labels sit above-left or below-right of it.
        const label = labelled.has(pointName(point)) ? null : pointName(point);
        labelled.add(pointName(point));
        const cx = x(point.costPerTask);
        const leftHalf = cx < CHART.left + plotWidth / 2;
        return (
          <g key={`${point.entry.instanceId}:${point.model.slug}:${point.effortLabel}`}>
            <circle cx={cx} cy={y(point.intelligence)} r={4} className="fill-primary">
              <title>{describe(point)}</title>
            </circle>
            {label ? (
              <text
                x={leftHalf ? cx + 7 : cx - 7}
                y={y(point.intelligence) + (leftHalf ? 14 : -8)}
                textAnchor={leftHalf ? "start" : "end"}
                className="fill-foreground"
              >
                {label}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
