import type {
  UsageProviderKind,
  UsageThreadBreakdownInput,
  UsageThreadDayCost,
} from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useMemo, useState } from "react";

import {
  enumerateDays,
  formatDayShort,
  formatPercent,
  formatTokens,
  formatUsd,
} from "@t3tools/shared/usageFormat";
import type { EnvironmentProviderContribution } from "@t3tools/shared/usageMerge";

import { useUsageThreads, type UsageThreadRowWithEnvironment } from "../../state/usage";
import { Badge } from "../ui/badge";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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
        <col className="w-[40%]" />
        <col className="w-[20%]" />
        <col className="w-[20%]" />
        <col className="w-[20%]" />
      </colgroup>
      <thead>
        <tr className="border-b border-border text-left text-xs text-muted-foreground">
          <th className="py-2 font-normal">Thread</th>
          <th className="py-2 text-right font-normal">Cost</th>
          <th className="py-2 text-right font-normal">Share</th>
          <th className="py-2 text-right font-normal">Tokens</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={4} className="py-6 text-center text-muted-foreground">
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
            <td colSpan={4} className="py-2 text-xs text-muted-foreground">
              {truncatedRows === 1
                ? "1 lower-cost thread row is grouped above."
                : `${truncatedRows} lower-cost thread rows are grouped above.`}
            </td>
          </tr>
        ) : null}
        {unavailableEnvironments > 0 && rows.length > 0 ? (
          <tr>
            <td colSpan={4} className="py-2 text-xs text-muted-foreground">
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
  return (
    <>
      <tr className="border-b border-border/50 transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50">
        <td className="py-2 text-foreground">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={onToggle}
                  aria-expanded={open}
                  className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
        </td>
        <td className="py-2 text-right text-foreground tabular-nums">{formatUsd(row.costUsd)}</td>
        <td className="py-2 text-right text-muted-foreground tabular-nums">
          {formatPercent(share)}
        </td>
        <td className="py-2 text-right text-muted-foreground tabular-nums">
          {formatTokens(tokens)}
        </td>
      </tr>
      {open ? (
        <tr className="border-b border-border/50">
          <td colSpan={4} className="py-3 ps-9">
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

/**
 * One thread's daily estimated cost. Static SVG, no animation.
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
  const peak = daily.reduce((max, entry) => Math.max(max, entry.costUsd), 0);

  if (peak === 0 || days.length === 0) {
    return <p className="pb-2 text-xs text-muted-foreground">No priced usage in this window.</p>;
  }

  const bandWidth = CHART_WIDTH / days.length;
  const barWidth = bandWidth * 0.8;

  return (
    <div className="flex max-w-3xl flex-col gap-1 pb-2">
      <div className="text-[11px] text-muted-foreground">
        <span>
          Daily cost, {formatDayShort(sinceDay)} to {formatDayShort(untilDay)}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        className="h-24 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label="Daily estimated cost for this thread"
      >
        {days.map((day, index) => {
          const entry = byDay.get(day);
          if (entry === undefined) return null;
          const x = index * bandWidth + (bandWidth - barWidth) / 2;
          const height = (entry.costUsd / peak) * (CHART_HEIGHT - 4);
          const renderedHeight = height === 0 ? 0 : Math.max(height, 0.75);
          return (
            <g key={day}>
              <title>{`${formatDayShort(day)}: ${formatUsd(entry.costUsd)}`}</title>
              <rect
                x={x}
                y={CHART_HEIGHT - renderedHeight}
                width={barWidth}
                height={renderedHeight}
                fill="currentColor"
                className="text-success"
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function ProviderMark({ provider }: { readonly provider: UsageProviderKind }) {
  const Mark = PROVIDER_PRESENTATION[provider].mark;
  return <Mark className="size-3.5 shrink-0" aria-hidden />;
}
