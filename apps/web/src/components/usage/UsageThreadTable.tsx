import type {
  UsageProviderKind,
  UsageThreadBreakdownInput,
  UsageThreadDayCost,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useMemo, useState } from "react";

import {
  enumerateDays,
  formatDayShort,
  formatPercent,
  formatTokens,
  formatUsd,
} from "@t3tools/shared/usageFormat";
import type { EnvironmentProviderContribution } from "@t3tools/shared/usageMerge";

import { cn } from "../../lib/utils";
import { useUsageThreads, type UsageThreadRowWithEnvironment } from "../../state/usage";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { UsageCacheWriteCell } from "./UsageCacheWriteCell";
import { PROVIDER_PRESENTATION } from "./usageProviders";

/**
 * On-demand thread drill-down behind the summary. Mounted only while the
 * Thread breakdown view is open, which is what defers the RPC.
 */
export function UsageThreadTable({
  input,
  providerContributions,
  summaryFailedEnvironments,
}: {
  readonly input: UsageThreadBreakdownInput;
  readonly providerContributions: readonly EnvironmentProviderContribution[];
  readonly summaryFailedEnvironments: number;
}) {
  const { rows, truncatedRows, isPending, failedEnvironments } = useUsageThreads(
    input,
    providerContributions,
  );
  const unavailableEnvironments = failedEnvironments + summaryFailedEnvironments;
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(new Set());
  const totalCostUsd = useMemo(() => rows.reduce((sum, row) => sum + row.costUsd, 0), [rows]);

  const toggleRow = (key: string) => {
    setOpenRows((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (isPending) {
    return (
      <div className="flex flex-col gap-2 py-1">
        {[56, 42, 68, 35].map((width) => (
          <Skeleton key={width} className="h-6" style={{ width: `${width}%` }} />
        ))}
      </div>
    );
  }

  return (
    <table className="w-full table-fixed text-sm">
      <colgroup>
        <col className="w-[32%]" />
        <col className="w-[17%]" />
        <col className="w-[17%]" />
        <col className="w-[17%]" />
        <col className="w-[17%]" />
      </colgroup>
      <thead>
        <tr className="border-b border-border text-left text-xs text-muted-foreground">
          <th className="py-2 font-normal">Thread</th>
          <th className="py-2 text-right font-normal">Cost</th>
          <th className="py-2 text-right font-normal">Cache writes</th>
          <th className="py-2 text-right font-normal">Share</th>
          <th className="py-2 text-right font-normal">Tokens</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={5} className="py-6 text-center text-muted-foreground">
              {unavailableEnvironments > 0
                ? "Thread activity could not be loaded for this window."
                : "No activity in this window."}
            </td>
          </tr>
        ) : (
          rows.map((row) => {
            const viewKey = `${row.environmentId}\u0000${row.key}`;
            const open = openRows.has(viewKey);
            const tokens =
              row.totals.uncachedInputTokens +
              row.totals.cachedInputTokens +
              row.totals.cacheCreationTokens +
              row.totals.outputTokens;
            return (
              <ThreadRowGroup
                key={viewKey}
                row={row}
                open={open}
                tokens={tokens}
                share={totalCostUsd === 0 ? 0 : row.costUsd / totalCostUsd}
                sinceDay={input.sinceDay}
                untilDay={input.untilDay}
                onToggle={() => toggleRow(viewKey)}
              />
            );
          })
        )}
        {truncatedRows > 0 ? (
          <tr>
            <td colSpan={5} className="py-2 text-xs text-muted-foreground">
              {truncatedRows === 1
                ? "1 lower-cost thread row is grouped above."
                : `${truncatedRows} lower-cost thread rows are grouped above.`}
            </td>
          </tr>
        ) : null}
        {unavailableEnvironments > 0 && rows.length > 0 ? (
          <tr>
            <td colSpan={5} className="py-2 text-xs text-muted-foreground">
              {unavailableEnvironments === 1
                ? "1 environment could not report threads."
                : `${unavailableEnvironments} environments could not report threads.`}
            </td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}

function ThreadRowGroup({
  row,
  open,
  tokens,
  share,
  sinceDay,
  untilDay,
  onToggle,
}: {
  readonly row: UsageThreadRowWithEnvironment;
  readonly open: boolean;
  readonly tokens: number;
  readonly share: number;
  readonly sinceDay: string;
  readonly untilDay: string;
  readonly onToggle: () => void;
}) {
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  const navigate = useNavigate();
  const threadId = row.threadId;
  return (
    <>
      <tr className="border-b border-border/50 transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50">
        <td className="py-2 text-foreground">
          <div className="flex min-w-0 items-center gap-1">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={onToggle}
                    aria-expanded={open}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                }
              >
                <Chevron className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <ProviderMark provider={row.provider} />
                <span className="truncate">{row.title}</span>
                {row.agents.length > 0 ? (
                  <Badge
                    variant="outline"
                    size="sm"
                    className="shrink-0 font-normal text-muted-foreground"
                  >
                    {row.agents.length === 1 ? "1 subagent" : `${row.agents.length} subagents`}
                  </Badge>
                ) : null}
              </TooltipTrigger>
              <TooltipPopup side="top">{row.title}</TooltipPopup>
            </Tooltip>
            {threadId === null ? null : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-micro"
                      variant="ghost-muted"
                      aria-label="Open thread"
                      className="shrink-0"
                      onClick={() => {
                        void navigate({
                          to: "/$environmentId/$threadId",
                          params: { environmentId: row.environmentId, threadId },
                        });
                      }}
                    />
                  }
                >
                  <ArrowUpRightIcon aria-hidden />
                </TooltipTrigger>
                <TooltipPopup side="top">Open thread</TooltipPopup>
              </Tooltip>
            )}
          </div>
        </td>
        <td className="py-2 text-right text-foreground tabular-nums">{formatUsd(row.costUsd)}</td>
        <UsageCacheWriteCell
          cacheWriteTokens={row.totals.cacheCreationTokens}
          cacheWriteUsd={row.cacheWriteUsd}
        />
        <td className="py-2 text-right text-muted-foreground tabular-nums">
          {formatPercent(share)}
        </td>
        <td className="py-2 text-right text-muted-foreground tabular-nums">
          {formatTokens(tokens)}
        </td>
      </tr>
      {open ? (
        <tr className="border-b border-border/50">
          <td colSpan={5} className="py-3 ps-9">
            <UsageThreadDailyChart daily={row.daily} sinceDay={sinceDay} untilDay={untilDay} />
            {row.agents.map((agent) => {
              const agentTokens =
                agent.totals.uncachedInputTokens +
                agent.totals.cachedInputTokens +
                agent.totals.cacheCreationTokens +
                agent.totals.outputTokens;
              return (
                <div
                  key={agent.agentId}
                  className="flex items-baseline justify-between gap-4 py-1 text-xs text-muted-foreground"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Badge variant="outline" size="sm" className="shrink-0 font-normal">
                      agent
                    </Badge>
                    <span className="truncate">{agent.agentId}</span>
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {formatUsd(agent.costUsd)} · {formatTokens(agentTokens)} tokens
                  </span>
                </div>
              );
            })}
          </td>
        </tr>
      ) : null}
    </>
  );
}

const CHART_WIDTH = 760;
const CHART_HEIGHT = 96;
const CHART_TOP = 4;

const EMPTY_DAY: Omit<UsageThreadDayCost, "day"> = {
  cacheWriteUsd: 0,
  cacheReadUsd: 0,
  freshUsd: 0,
};

const CHART_BANDS = [
  {
    key: "freshUsd",
    label: "fresh input + output",
    className: "text-success",
    lowerKeys: [],
  },
  {
    key: "cacheReadUsd",
    label: "cache reads",
    className: "text-muted-foreground",
    lowerKeys: ["freshUsd"],
  },
  {
    key: "cacheWriteUsd",
    label: "cache writes",
    className: "text-info",
    lowerKeys: ["freshUsd", "cacheReadUsd"],
  },
] as const;

type ChartCostKey = (typeof CHART_BANDS)[number]["key"];

function dayCost(entry: Omit<UsageThreadDayCost, "day">): number {
  return entry.cacheWriteUsd + entry.cacheReadUsd + entry.freshUsd;
}

/** Rounds the ceiling up without leaving a compact thread chart mostly empty. */
function chartCeiling(peak: number): number {
  if (peak <= 0) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  const normalized = peak / magnitude;
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate >= normalized) ?? 10;
  return step * magnitude;
}

function chartNumber(value: number): string {
  return value.toFixed(2).replace(/\.00$/, "");
}

/** One filled band between two cumulative step boundaries. */
function steppedAreaPath(
  columns: readonly Omit<UsageThreadDayCost, "day">[],
  key: ChartCostKey,
  lowerKeys: readonly ChartCostKey[],
  ceiling: number,
): string {
  if (columns.length === 0 || ceiling <= 0) return "";
  if (columns.every((column) => column[key] === 0)) return "";

  const width = CHART_WIDTH / columns.length;
  const y = (value: number) =>
    chartNumber(CHART_HEIGHT - (value / ceiling) * (CHART_HEIGHT - CHART_TOP));
  const lower = columns.map((column) =>
    lowerKeys.reduce((sum, lowerKey) => sum + column[lowerKey], 0),
  );
  const upper = columns.map((column, index) => (lower[index] ?? 0) + column[key]);
  let path = `M0,${y(upper[0] ?? 0)}`;

  for (let index = 0; index < columns.length; index += 1) {
    const right = chartNumber((index + 1) * width);
    path += ` H${right}`;
    const next = upper[index + 1];
    if (next !== undefined) path += ` V${y(next)}`;
  }

  path += ` L${CHART_WIDTH},${y(lower.at(-1) ?? 0)}`;
  for (let index = columns.length - 1; index >= 0; index -= 1) {
    const left = chartNumber(index * width);
    path += ` H${left}`;
    const previous = lower[index - 1];
    if (previous !== undefined) path += ` V${y(previous)}`;
  }
  return `${path} Z`;
}

/**
 * One thread's daily model-priced cost stacked by component: cache writes,
 * cache reads, and fresh input plus output. Cache writes are a billing
 * category, not an inferred cause. Static SVG, no animation.
 */
export function UsageThreadDailyChart({
  daily,
  sinceDay,
  untilDay,
}: {
  readonly daily: readonly UsageThreadDayCost[];
  readonly sinceDay: string;
  readonly untilDay: string;
}) {
  const days = useMemo(() => enumerateDays(sinceDay, untilDay), [sinceDay, untilDay]);
  const byDay = useMemo(
    () => new Map<string, UsageThreadDayCost>(daily.map((entry) => [entry.day, entry])),
    [daily],
  );
  const columns = days.map((day) => byDay.get(day) ?? EMPTY_DAY);
  const peakEntry = daily.reduce<UsageThreadDayCost | undefined>(
    (largest, entry) =>
      largest === undefined || dayCost(entry) > dayCost(largest) ? entry : largest,
    undefined,
  );

  if (peakEntry === undefined || dayCost(peakEntry) === 0 || days.length === 0) {
    return <p className="pb-2 text-xs text-muted-foreground">No priced usage in this window.</p>;
  }

  const peak = dayCost(peakEntry);
  const ceiling = chartCeiling(peak);
  const bandWidth = CHART_WIDTH / days.length;
  const labelDays = [days[0], days[Math.floor((days.length - 1) / 2)], days.at(-1)].filter(
    (day, index, labels): day is string => day !== undefined && labels.indexOf(day) === index,
  );

  return (
    <div className="flex max-w-3xl flex-col gap-1 pb-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span>
          Daily cost, {formatDayShort(sinceDay)} to {formatDayShort(untilDay)}
        </span>
        <span className="tabular-nums text-foreground">
          Peak {formatUsd(peak)} · {formatDayShort(peakEntry.day)}
        </span>
      </div>
      <div className="flex flex-wrap justify-end gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        {CHART_BANDS.toReversed().map((band) => (
          <span key={band.key} className="flex items-center gap-1">
            <span aria-hidden className={`size-1.5 rounded-[2px] bg-current ${band.className}`} />
            {band.label}
          </span>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        className="h-24 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label="Daily model-priced cost for this thread by component"
        shapeRendering="crispEdges"
      >
        <line
          x1={0}
          y1={CHART_TOP}
          x2={CHART_WIDTH}
          y2={CHART_TOP}
          stroke="currentColor"
          className="text-border"
          vectorEffect="non-scaling-stroke"
        />
        {CHART_BANDS.map((band) => (
          <path
            key={band.key}
            d={steppedAreaPath(columns, band.key, band.lowerKeys, ceiling)}
            fill="currentColor"
            className={band.className}
          />
        ))}
        {days.map((day, index) => {
          const entry = byDay.get(day) ?? EMPTY_DAY;
          const total = dayCost(entry);
          return (
            <rect
              key={day}
              x={index * bandWidth}
              y={0}
              width={bandWidth}
              height={CHART_HEIGHT}
              fill="transparent"
            >
              <title>{`${formatDayShort(day)}: ${formatUsd(total)}. Cache writes ${formatUsd(entry.cacheWriteUsd)}, cache reads ${formatUsd(entry.cacheReadUsd)}, fresh input and output ${formatUsd(entry.freshUsd)}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        {labelDays.map((day) => (
          <span key={day}>{formatDayShort(day)}</span>
        ))}
      </div>
    </div>
  );
}

function LegendSwatch({
  className,
  label,
}: {
  readonly className: string;
  readonly label: string;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden className={cn("size-2 rounded-[2px] bg-current", className)} />
      {label}
    </span>
  );
}

function ProviderMark({ provider }: { readonly provider: UsageProviderKind }) {
  const Mark = PROVIDER_PRESENTATION[provider].mark;
  return <Mark className="size-3.5 shrink-0" aria-hidden />;
}
