import {
  DEFAULT_USAGE_VIEW,
  formatAllowanceDuration,
  formatAllowanceEnvironmentNotice,
  formatAllowanceResetAt,
  formatAllowanceUpdatedAt,
  formatAllowanceWindowScope,
  presentSubscriptionAllowanceGroup,
  progressWidthForAllowance,
  shouldShowExtraUsage,
  shouldShowSpendingControl,
  subscriptionViewPhase,
  USAGE_VIEW_OPTIONS,
  type SubscriptionAllowanceCardModel,
  type UsageView,
} from "@t3tools/client-runtime/state/subscription-allowance";
import type { UsageProviderKind } from "@t3tools/contracts";
import {
  enumerateDays,
  enumerateHourStarts,
  formatCount,
  formatDateTimeShort,
  formatDayShort,
  formatHourShort,
  formatPercent,
  formatTokens,
  formatUsd,
  makeWindow,
} from "@t3tools/shared/usageFormat";
import type { DailyTotals, HourlyTotals } from "@t3tools/shared/usageMerge";
import { CheckIcon, RefreshCwIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";

import { isElectron } from "../../env";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { useSubscriptionAllowance } from "../../state/subscriptionAllowance";
import { useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { UsageProviderChart, type UsageChartMetric } from "./UsageProviderChart";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "./usageProviders";

const WINDOW_OPTIONS = [
  { days: 1, label: "Past 24h" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

type HistoricalWindowSelection = {
  readonly days: number;
  readonly window: ReturnType<typeof makeWindow>;
};

type HistoricalBreakdown = "model" | "time";

export function UsagePage() {
  const [view, setView] = useState<UsageView>(DEFAULT_USAGE_VIEW);
  const [windowSelection, setWindowSelection] = useState<HistoricalWindowSelection>(() => ({
    days: 30,
    window: makeWindow(30),
  }));
  const [metric, setMetric] = useState<UsageChartMetric>("cost");
  const [breakdown, setBreakdown] = useState<HistoricalBreakdown>("model");

  return view === "historical" ? (
    <HistoricalUsagePage
      onViewChange={setView}
      windowSelection={windowSelection}
      onWindowSelectionChange={setWindowSelection}
      metric={metric}
      onMetricChange={setMetric}
      breakdown={breakdown}
      onBreakdownChange={setBreakdown}
    />
  ) : (
    <SubscriptionUsagePage onViewChange={setView} />
  );
}

function HistoricalUsagePage({
  onViewChange,
  windowSelection,
  onWindowSelectionChange,
  metric,
  onMetricChange,
  breakdown,
  onBreakdownChange,
}: {
  readonly onViewChange: (view: UsageView) => void;
  readonly windowSelection: HistoricalWindowSelection;
  readonly onWindowSelectionChange: (selection: HistoricalWindowSelection) => void;
  readonly metric: UsageChartMetric;
  readonly onMetricChange: (metric: UsageChartMetric) => void;
  readonly breakdown: HistoricalBreakdown;
  readonly onBreakdownChange: (breakdown: HistoricalBreakdown) => void;
}) {
  const { days: windowDays, window } = windowSelection;
  const isPast24Hours = windowDays === 1;
  const { merged, environments, isPending, isPartial, refresh } = useUsage(window);

  // Hold the content until every environment is terminal. Rendering merged
  // totals while devices are still answering makes every number on the page
  // jump as each one lands.
  const settling = isPending || isPartial;

  const days = useMemo(
    () => enumerateDays(window.sinceDay, window.untilDay),
    [window.sinceDay, window.untilDay],
  );
  const hours = useMemo(
    () =>
      window.sinceTime === undefined || window.untilTime === undefined
        ? []
        : enumerateHourStarts(window.sinceTime, window.untilTime),
    [window.sinceTime, window.untilTime],
  );
  // Newest first: the window can run 90 periods, so the interesting end
  // belongs at the top of the table.
  const breakdownPeriods = useMemo<readonly (DailyTotals | HourlyTotals)[]>(
    () => (isPast24Hours ? merged.hourly : merged.daily).toReversed(),
    [isPast24Hours, merged.daily, merged.hourly],
  );

  const selectWindow = (days: number) => {
    onWindowSelectionChange({
      days,
      window: makeWindow(days, undefined, days === 1 ? "hour" : "day"),
    });
  };
  const refreshWindow = () => {
    const nextWindow = makeWindow(windowDays, undefined, isPast24Hours ? "hour" : "day");
    if (
      nextWindow.sinceDay === window.sinceDay &&
      nextWindow.untilDay === window.untilDay &&
      nextWindow.sinceTime === window.sinceTime &&
      nextWindow.untilTime === window.untilTime
    ) {
      refresh();
    } else {
      onWindowSelectionChange({ days: windowDays, window: nextWindow });
    }
  };
  const windowLabel =
    isPast24Hours && window.sinceTime !== undefined && window.untilTime !== undefined
      ? `${formatDateTimeShort(window.sinceTime, window.timeZone)} to ${formatDateTimeShort(window.untilTime, window.timeZone)}`
      : `${formatDayShort(window.sinceDay)} to ${formatDayShort(window.untilDay)}`;
  const topbarContent = (
    <div className="flex w-full min-w-0 items-center gap-3">
      <WorkspaceBreadcrumb ariaLabel="Usage breadcrumb" className="min-w-0">
        <WorkspaceBreadcrumbItem current>
          <h1>Usage</h1>
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator className="hidden md:flex" />
        <WorkspaceBreadcrumbItem className="hidden min-w-0 shrink md:flex">
          <span className="truncate">{windowLabel}</span>
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      <div className="ms-auto hidden min-w-0 items-center justify-end gap-2 lg:flex">
        <ToggleGroup
          aria-label="Usage metric"
          variant="segmented"
          value={[metric]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "cost" || value === "tokens") onMetricChange(value);
          }}
        >
          {(["cost", "tokens"] as const).map((option) => (
            <Toggle key={option} value={option}>
              {option === "cost" ? "Cost" : "Tokens"}
            </Toggle>
          ))}
        </ToggleGroup>
        <ToggleGroup
          aria-label="Usage period"
          variant="segmented"
          value={[String(windowDays)]}
          onValueChange={(next) => {
            const value = next[0];
            if (value) selectWindow(Number(value));
          }}
        >
          {WINDOW_OPTIONS.map((option) => (
            <Toggle key={option.days} value={String(option.days)}>
              {option.label}
            </Toggle>
          ))}
        </ToggleGroup>
        <Button onClick={refreshWindow} aria-label="Refresh usage" size="icon-sm" variant="ghost">
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
      <div className="ms-auto flex min-w-0 items-center justify-end gap-1 lg:hidden">
        <Select
          value={metric}
          onValueChange={(value) => {
            if (value === "cost" || value === "tokens") onMetricChange(value);
          }}
        >
          <SelectTrigger
            aria-label="Usage metric"
            size="compact"
            variant="ghost"
            className="w-auto min-w-0"
          >
            <SelectValue>{metric === "cost" ? "Cost" : "Tokens"}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="cost">Cost</SelectItem>
            <SelectItem value="tokens">Tokens</SelectItem>
          </SelectPopup>
        </Select>
        <Select value={String(windowDays)} onValueChange={(value) => selectWindow(Number(value))}>
          <SelectTrigger
            aria-label="Usage period"
            size="compact"
            variant="ghost"
            className="w-auto min-w-0"
          >
            <SelectValue>
              {WINDOW_OPTIONS.find((option) => option.days === windowDays)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {WINDOW_OPTIONS.map((option) => (
              <SelectItem key={option.days} value={String(option.days)}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button onClick={refreshWindow} aria-label="Refresh usage" size="icon-sm" variant="ghost">
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );

  return (
    <UsagePageFrame topbarContent={topbarContent}>
      <WorkspacePageContainer width="wide">
        <div className="flex justify-center">
          <UsageViewTabs value="historical" onChange={onViewChange} />
        </div>
        {settling ? (
          <>
            {environments.length > 1 ? <UsageDeviceStrip environments={environments} /> : null}
            <UsageSkeleton resolution={isPast24Hours ? "hour" : "day"} metric={metric} />
          </>
        ) : (
          <>
            <UsageCoverageNotice
              environments={environments}
              duplicateSources={merged.duplicateSources}
              staleEnvironments={merged.staleEnvironments}
            />

            <section className="grid gap-6 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
              <div className="flex min-w-0 flex-col gap-5">
                <div className="flex flex-col gap-1">
                  <span className="text-4xl font-semibold text-foreground tabular-nums">
                    {metric === "cost"
                      ? formatUsd(merged.costUsd)
                      : formatTokens(merged.totalTokens)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {metric === "cost"
                      ? `${formatCount(merged.sessions)} sessions · API estimate`
                      : `${formatCount(merged.sessions)} sessions`}
                  </span>
                </div>

                {PROVIDER_ORDER.map((provider) => {
                  const totals = merged.providers.find((entry) => entry.provider === provider);
                  const share =
                    metric === "cost" ? (totals?.costShare ?? 0) : (totals?.tokenShare ?? 0);
                  const providerSessions = totals?.sessions ?? 0;
                  const sessionLabel = `${formatCount(providerSessions)} ${
                    providerSessions === 1 ? "session" : "sessions"
                  }`;
                  return (
                    <div key={provider} className="flex flex-col gap-1">
                      <div className="flex items-baseline justify-between gap-4">
                        <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                          <span
                            aria-hidden
                            className="size-2 shrink-0 rounded-full"
                            style={{
                              backgroundColor: PROVIDER_PRESENTATION[provider].color,
                            }}
                          />
                          <ProviderMark provider={provider} className="size-4" />
                          <span className="flex min-w-0 items-baseline gap-1.5">
                            <span className="truncate">
                              {PROVIDER_PRESENTATION[provider].label}
                            </span>
                            <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground tabular-nums">
                              {sessionLabel}
                            </span>
                          </span>
                        </span>
                        <span className="shrink-0 text-sm font-medium text-foreground tabular-nums">
                          {metric === "cost"
                            ? formatUsd(totals?.costUsd ?? 0)
                            : formatTokens(totals?.totalTokens ?? 0)}
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {metric === "cost"
                          ? `${formatPercent(share)} of cost · ${formatTokens(totals?.totalTokens ?? 0)} tokens`
                          : `${formatPercent(share)} of tokens · ${formatUsd(totals?.costUsd ?? 0)}`}
                      </span>
                    </div>
                  );
                })}
              </div>

              <div className="flex min-w-0 flex-col gap-3">
                <h2 className="text-sm font-medium text-foreground">
                  {isPast24Hours ? "Hourly" : "Daily"}{" "}
                  {metric === "tokens" ? "processed tokens" : "cost"}
                </h2>
                <UsageProviderChart
                  days={days}
                  daily={merged.daily}
                  hours={hours}
                  hourly={merged.hourly}
                  metric={metric}
                  referenceTime={window.untilTime}
                  resolution={isPast24Hours ? "hour" : "day"}
                  timeZone={window.timeZone}
                />
              </div>
            </section>

            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-medium text-foreground">Totals</h2>
              <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
                <Metric label="Processed tokens" value={formatTokens(merged.totalTokens)} />
                <Metric label="Cached input" value={formatTokens(merged.cachedInputTokens)} />
                <Metric label="Uncached input" value={formatTokens(merged.uncachedInputTokens)} />
                <Metric label="Output" value={formatTokens(merged.outputTokens)} />
                <Metric
                  label="Cache savings"
                  value={formatUsd(merged.costQuality.cacheSavingsUsd)}
                />
              </div>
            </section>

            <section className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-medium text-foreground">Breakdown</h2>
                <ToggleGroup
                  aria-label="Usage breakdown"
                  variant="segmented"
                  value={[breakdown]}
                  onValueChange={(next) => {
                    const value = next[0];
                    if (value === "model" || value === "time") onBreakdownChange(value);
                  }}
                >
                  {(
                    [
                      { value: "model", label: "Model" },
                      { value: "time", label: isPast24Hours ? "Hour" : "Day" },
                    ] as const
                  ).map((option) => (
                    <Toggle key={option.value} value={option.value}>
                      {option.label}
                    </Toggle>
                  ))}
                </ToggleGroup>
              </div>

              {breakdown === "model" ? (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="py-2 font-normal">Model</th>
                      <th className="py-2 text-right font-normal">Cost</th>
                      <th className="py-2 text-right font-normal">Share</th>
                      <th className="py-2 text-right font-normal">Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {merged.models.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="py-6 text-center text-muted-foreground">
                          No activity in this window.
                        </td>
                      </tr>
                    ) : (
                      merged.models.map((model) => (
                        <tr
                          key={`${model.provider}:${model.model}`}
                          className="border-b border-border/50 transition-colors hover:bg-muted/50"
                        >
                          <td className="py-2 text-foreground">
                            <span className="flex items-center gap-2">
                              <ProviderMark provider={model.provider} className="size-3.5" />
                              {model.model}
                            </span>
                          </td>
                          <td className="py-2 text-right text-foreground tabular-nums">
                            {formatUsd(model.costUsd)}
                          </td>
                          <td className="py-2 text-right text-muted-foreground tabular-nums">
                            {formatPercent(model.costShare)}
                          </td>
                          <td className="py-2 text-right text-muted-foreground tabular-nums">
                            {formatTokens(model.totalTokens)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="py-2 font-normal">{isPast24Hours ? "Hour" : "Day"}</th>
                      {PROVIDER_ORDER.map((provider) => (
                        <th key={provider} className="py-2 text-right font-normal">
                          {PROVIDER_PRESENTATION[provider].label}
                        </th>
                      ))}
                      <th className="py-2 text-right font-normal">Total</th>
                      <th className="py-2 text-right font-normal">Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {breakdownPeriods.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-6 text-center text-muted-foreground">
                          No activity in this window.
                        </td>
                      </tr>
                    ) : (
                      breakdownPeriods.map((period) => (
                        <tr
                          key={"hourStart" in period ? period.hourStart : period.day}
                          className="border-b border-border/50 transition-colors hover:bg-muted/50"
                        >
                          <td className="py-2 text-foreground">
                            {"hourStart" in period
                              ? formatHourShort(period.hourStart, window.timeZone)
                              : formatDayShort(period.day)}
                          </td>
                          {PROVIDER_ORDER.map((provider) => (
                            <td
                              key={provider}
                              className="py-2 text-right text-muted-foreground tabular-nums"
                            >
                              {formatUsd(period.byProvider.get(provider)?.costUsd ?? 0)}
                            </td>
                          ))}
                          <td className="py-2 text-right text-foreground tabular-nums">
                            {formatUsd(period.costUsd)}
                          </td>
                          <td className="py-2 text-right text-muted-foreground tabular-nums">
                            {formatTokens(period.totalTokens)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              )}
            </section>
          </>
        )}
      </WorkspacePageContainer>
    </UsagePageFrame>
  );
}

const DEFAULT_USAGE_TOPBAR_CONTENT = (
  <WorkspaceBreadcrumb ariaLabel="Usage breadcrumb">
    <WorkspaceBreadcrumbItem current>
      <h1>Usage</h1>
    </WorkspaceBreadcrumbItem>
  </WorkspaceBreadcrumb>
);

function UsagePageFrame({
  children,
  topbarContent = DEFAULT_USAGE_TOPBAR_CONTENT,
}: {
  readonly children: ReactNode;
  readonly topbarContent?: ReactNode;
}) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>{topbarContent}</WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">{children}</ScrollArea>
      </div>
    </SidebarInset>
  );
}

export function UsageViewTabs({
  value,
  onChange,
}: {
  readonly value: UsageView;
  readonly onChange: (view: UsageView) => void;
}) {
  return (
    <ToggleGroup
      aria-label="Usage view"
      variant="segmented"
      value={[value]}
      onValueChange={(next) => {
        const selected = next[0];
        if (selected === "subscription" || selected === "historical") onChange(selected);
      }}
    >
      {USAGE_VIEW_OPTIONS.map((option) => (
        <Toggle key={option.value} value={option.value}>
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

function SubscriptionUsagePage({
  onViewChange,
}: {
  readonly onViewChange: (view: UsageView) => void;
}) {
  const { groups, environments, isPending, isPartial, isRefreshing, refresh } =
    useSubscriptionAllowance();
  const environmentNotices = environments.flatMap((environment) => {
    const message = formatAllowanceEnvironmentNotice(environment);
    return message === null ? [] : [{ environmentId: environment.environmentId, message }];
  });
  const phase = subscriptionViewPhase({
    isPending,
    isPartial,
    groupCount: groups.length,
  });

  return (
    <UsagePageFrame>
      <WorkspacePageContainer width="wide">
        <div className="flex justify-center">
          <UsageViewTabs value="subscription" onChange={onViewChange} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium text-foreground">Subscription allowance</h2>
            <p className="text-sm text-muted-foreground">
              Usage limits and reset times from your provider.
            </p>
          </div>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  onClick={refresh}
                  aria-label={
                    isRefreshing ? "Refreshing subscription usage" : "Refresh subscription usage"
                  }
                  aria-busy={isRefreshing}
                />
              }
            >
              <RefreshCwIcon className={cn("size-3.5", isRefreshing && "animate-spin")} />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {isRefreshing ? "Refreshing subscription usage…" : "Refresh subscription usage"}
            </TooltipPopup>
          </Tooltip>
        </div>

        {phase === "loading" ? (
          <div className="border border-border px-4 py-6 text-sm text-muted-foreground">
            Reading provider allowance…
          </div>
        ) : groups.length === 0 ? (
          <div className="flex flex-col gap-1 border border-border px-4 py-6 text-sm text-muted-foreground">
            {environmentNotices.length > 0 ? (
              environmentNotices.map((notice) => (
                <span key={notice.environmentId}>{notice.message}</span>
              ))
            ) : environments.length === 0 ? (
              <span>Connect an environment to see subscription allowance data.</span>
            ) : (
              <span>No enabled provider reports subscription allowance data.</span>
            )}
          </div>
        ) : (
          <>
            {environmentNotices.length > 0 ? (
              <div className="flex flex-col gap-1 border border-border px-4 py-3 text-xs text-muted-foreground">
                {environmentNotices.map((notice) => (
                  <span key={notice.environmentId}>{notice.message}</span>
                ))}
              </div>
            ) : null}
            {phase === "partial" ? (
              <p className="text-xs text-muted-foreground">
                Some environments are still reporting.
              </p>
            ) : null}
            <section className={cn("grid gap-4", groups.length > 1 && "lg:grid-cols-2")}>
              {groups.map((group) => (
                <SubscriptionAllowanceCard
                  key={group.key}
                  model={presentSubscriptionAllowanceGroup(group)}
                />
              ))}
            </section>
          </>
        )}
      </WorkspacePageContainer>
    </UsagePageFrame>
  );
}

function SubscriptionAllowanceCard({
  model: allowance,
}: {
  readonly model: SubscriptionAllowanceCardModel;
}) {
  const nowMinute = useNowMinute();
  const updatedAt = formatAllowanceUpdatedAt(
    allowance.updatedAt,
    Date.parse(`${nowMinute}:00.000Z`),
  );
  const spendingControlReset =
    allowance.spendingControl?.resetsAt === undefined || allowance.spendingControl.resetsAt === null
      ? null
      : formatAllowanceResetAt(allowance.spendingControl.resetsAt);

  return (
    <article className="flex flex-col gap-5 border border-border p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <ProviderMark provider={allowance.provider} className="size-4" />
          {PROVIDER_PRESENTATION[allowance.provider].label}
          {allowance.accountLabel !== null ? (
            <span className="font-normal text-muted-foreground">{allowance.accountLabel}</span>
          ) : null}
        </h2>
        <div className="flex flex-col items-end gap-1 text-xs text-muted-foreground">
          <span className={allowance.isStale ? "text-warning-foreground" : undefined}>
            {allowance.isStale
              ? updatedAt === null
                ? "Stale"
                : `Stale · ${updatedAt}`
              : (updatedAt ?? "Updated time unavailable")}
          </span>
        </div>
      </div>

      {allowance.status === "unavailable" ? (
        <p className="text-sm text-muted-foreground">
          {allowance.message ?? "Subscription usage is unavailable."}
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-4">
            {allowance.windows.map((window) => {
              const duration = formatAllowanceDuration(window.windowDurationMins);
              const reset =
                window.resetsAt === undefined || window.resetsAt === null
                  ? null
                  : formatAllowanceResetAt(window.resetsAt);
              const hasUsage = window.usedPercent !== undefined && window.usedPercent !== null;
              return (
                <div key={window.scope} className="flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="text-foreground">
                      {formatAllowanceWindowScope(window.scope)}
                    </span>
                    <span className="text-foreground tabular-nums">
                      {hasUsage ? `${window.usedPercent}% used` : "Not reported"}
                    </span>
                  </div>
                  {hasUsage ? (
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full"
                        style={{
                          width: `${progressWidthForAllowance(window.usedPercent)}%`,
                          backgroundColor: PROVIDER_PRESENTATION[allowance.provider].color,
                        }}
                      />
                    </div>
                  ) : null}
                  {duration !== null || reset !== null ? (
                    <span className="text-xs text-muted-foreground">
                      {[duration, reset === null ? null : `Resets ${reset}`]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>

          {allowance.credits !== undefined && allowance.credits !== null ? (
            <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
              <span>Credits</span>
              {allowance.credits.balance !== undefined && allowance.credits.balance !== null ? (
                <span>Balance {allowance.credits.balance}</span>
              ) : null}
              <span>
                {allowance.credits.unlimited
                  ? "Unlimited"
                  : allowance.credits.hasCredits
                    ? "Available"
                    : "No credits"}
              </span>
            </div>
          ) : null}

          {allowance.spendingControl !== null &&
          shouldShowSpendingControl(allowance.spendingControl) ? (
            <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
              <span>Spending control</span>
              {allowance.spendingControl.limit !== undefined &&
              allowance.spendingControl.limit !== null ? (
                <span>Limit {allowance.spendingControl.limit}</span>
              ) : null}
              {allowance.spendingControl.used !== undefined &&
              allowance.spendingControl.used !== null ? (
                <span>Used {allowance.spendingControl.used}</span>
              ) : null}
              {allowance.spendingControl.remainingPercent !== undefined &&
              allowance.spendingControl.remainingPercent !== null ? (
                <span>{allowance.spendingControl.remainingPercent}% remaining</span>
              ) : null}
              {spendingControlReset !== null ? <span>Resets {spendingControlReset}</span> : null}
              {allowance.spendingControl.reached === true ? <span>Limit reached</span> : null}
            </div>
          ) : null}

          {allowance.extraUsage !== null && shouldShowExtraUsage(allowance.extraUsage) ? (
            <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
              <span>Extra usage</span>
              <span>{allowance.extraUsage.isEnabled ? "Enabled" : "Disabled"}</span>
              {allowance.extraUsage.monthlyLimit !== null ? (
                <span>Monthly limit {allowance.extraUsage.monthlyLimit}</span>
              ) : null}
              {allowance.extraUsage.usedCredits !== null ? (
                <span>Used credits {allowance.extraUsage.usedCredits}</span>
              ) : null}
              {allowance.extraUsage.utilization !== null ? (
                <span>{allowance.extraUsage.utilization}% used</span>
              ) : null}
              {allowance.extraUsage.currency !== undefined &&
              allowance.extraUsage.currency !== null ? (
                <span>{allowance.extraUsage.currency}</span>
              ) : null}
            </div>
          ) : null}
        </>
      )}
      {allowance.hasMultipleReadings ? (
        <p className="border-t border-border pt-3 text-xs text-muted-foreground">
          Multiple readings are available; showing one whole provider source.
        </p>
      ) : null}
      {allowance.sources.length > 1 ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
          <span>Sources</span>
          {allowance.sources.map((source) => (
            <span key={source.key}>
              {source.environmentLabel} · {source.instanceId} ·{" "}
              {source.connectionLabel.toLowerCase()}
              {source.status === "unavailable" ? " · unavailable" : ""}
              {source.isStale ? " · stale" : ""}
              {source.isEffective ? " · shown" : ""}
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
}

/** Brand mark for the harness a row belongs to. */
function ProviderMark({
  provider,
  className,
}: {
  readonly provider: UsageProviderKind;
  readonly className: string;
}) {
  const Mark = PROVIDER_PRESENTATION[provider].mark;
  return <Mark className={cn("shrink-0", className)} aria-hidden />;
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-base font-medium text-foreground tabular-nums">{value}</span>
    </div>
  );
}

/**
 * Says plainly when the totals are incomplete: an environment that failed, or
 * one whose transcripts another environment already reported. Environments
 * that are still answering never reach this notice; the page shows the
 * loading skeleton until every one is terminal.
 */
function UsageCoverageNotice({
  environments,
  duplicateSources,
  staleEnvironments,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly duplicateSources: readonly string[];
  readonly staleEnvironments: readonly string[];
}) {
  const failed = environments.filter((environment) => environment.error !== null);
  const stale = environments.filter((environment) =>
    staleEnvironments.includes(environment.environmentId),
  );
  if (failed.length === 0 && stale.length === 0 && duplicateSources.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1 border border-border px-3 py-2 text-xs text-muted-foreground">
      {failed.map((environment) => (
        <span key={environment.label}>{environment.label} could not report usage.</span>
      ))}
      {stale.map((environment) => (
        <span key={environment.label}>
          {environment.label} runs an older server version and is excluded from totals.
        </span>
      ))}
      {duplicateSources.length > 0 ? (
        <span>
          Counted once across environments sharing a transcript directory:{" "}
          {duplicateSources.join(", ")}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Per-device progress while the page waits for every environment to answer.
 * Only rendered with two or more devices; a lone device has nothing to
 * enumerate.
 */
function UsageDeviceStrip({
  environments,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
}) {
  const scanning = environments.filter(
    (environment) => environment.summary === null && environment.error === null,
  );
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border border-border px-3 py-2 text-xs">
      {environments.map((environment) => {
        if (environment.summary !== null) {
          return (
            <span
              key={environment.environmentId}
              className="flex items-center gap-1 text-foreground"
            >
              <CheckIcon className="size-3 text-emerald-600 dark:text-emerald-300/90" aria-hidden />
              {environment.label}
            </span>
          );
        }
        if (environment.error !== null) {
          return (
            <span
              key={environment.environmentId}
              className="flex items-center gap-1 text-destructive"
            >
              <XIcon className="size-3" aria-hidden />
              {environment.label}
            </span>
          );
        }
        return (
          <span
            key={environment.environmentId}
            className="animate-status-pulse text-muted-foreground"
          >
            {environment.label}…
          </span>
        );
      })}
      <span className="ms-auto text-muted-foreground">
        {scanning.length === 1
          ? "1 device still scanning"
          : `${scanning.length} devices still scanning`}
      </span>
    </div>
  );
}

/**
 * Static stand-in with the loaded page's shape. No shimmer; blocks fill in
 * exactly once when the last device answers.
 */
export function UsageSkeleton({
  resolution,
  metric,
}: {
  readonly resolution: "day" | "hour";
  readonly metric: UsageChartMetric;
}) {
  return (
    <>
      <section className="grid gap-6 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <div className="h-10 w-36 rounded-sm bg-muted" />
            <div className="h-4 w-32 rounded-sm bg-muted" />
          </div>
          {PROVIDER_ORDER.map((provider) => (
            <div key={provider} className="flex flex-col gap-1">
              <div className="flex min-h-5 items-center justify-between gap-4">
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: PROVIDER_PRESENTATION[provider].color }}
                  />
                  <ProviderMark provider={provider} className="size-4" />
                  <div className="h-3.5 w-20 rounded-sm bg-muted" />
                </span>
                <div className="h-3.5 w-14 rounded-sm bg-muted" />
              </div>
              <div className="h-4 w-36 rounded-sm bg-muted" />
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-foreground">
            {resolution === "hour" ? "Hourly" : "Daily"}{" "}
            {metric === "tokens" ? "processed tokens" : "cost"}
          </h2>
          <div className="flex flex-col gap-1">
            <div className="ml-16 h-56 rounded-sm bg-muted/35" />
            <div className="ml-16 h-3 rounded-sm bg-muted/35" />
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-foreground">Totals</h2>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
          {["Processed tokens", "Cached input", "Uncached input", "Output", "Cache savings"].map(
            (label) => (
              <div key={label} className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">{label}</span>
                <div className="my-0.5 h-4 w-16 rounded-sm bg-muted" />
              </div>
            ),
          )}
        </div>
      </section>
    </>
  );
}
