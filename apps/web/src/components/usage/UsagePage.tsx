import { useAtomValue } from "@effect/atom-react";
import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageProviderKind,
} from "@t3tools/contracts";
import {
  CircleAlertIcon,
  ChevronDownIcon,
  CircleDashedIcon,
  RefreshCwIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import {
  isCompatibleUsageContractVersion,
  projectFilterForEnvironment,
  type DailyTotals,
  type HourlyTotals,
  type ProjectTotals,
} from "@t3tools/shared/usageMerge";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  compareUsageDays,
  enumerateDays,
  enumerateHourStarts,
  formatCount,
  formatDateTimeShort,
  formatDayShort,
  formatHourShort,
  formatPercent,
  formatTokens,
  formatUsd,
  makeCustomWindow,
  makeWindow,
} from "@t3tools/shared/usageFormat";
import { useCommitOnBlur } from "../../hooks/useCommitOnBlur";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { segmentedControlGroupClassName } from "../ui/segmented-control-styles";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { UsageLimitsSection } from "./UsageLimits";
import { UsagePriceOverrides } from "./UsagePriceOverrides";
import { UsageProviderChart, type UsageChartMetric } from "./UsageProviderChart";
import { UsageCacheWriteCell } from "./UsageCacheWriteCell";
import { UsageThreadTable } from "./UsageThreadTable";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION, providersWithUsage } from "./usageProviders";

type UsageMetric = UsageChartMetric | "limits";
const METRIC_OPTIONS = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
  { value: "limits", label: "Limits" },
] as const satisfies readonly { value: UsageMetric; label: string }[];

function isUsageMetric(value: string | null | undefined): value is UsageMetric {
  return METRIC_OPTIONS.some((option) => option.value === value);
}

const WINDOW_OPTIONS = [
  { days: 1, label: "Past 24h" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

export function UsagePage() {
  // `days` remembers the last preset even while a custom (brushed or typed)
  // range is active, so a reset lands back where the user started.
  const [windowSelection, setWindowSelection] = useState(() => ({
    days: 30,
    custom: false,
    window: makeWindow(30),
  }));
  const [metric, setMetric] = useState<UsageMetric>("cost");
  const showingLimits = metric === "limits";
  const [breakdown, setBreakdown] = useState<"model" | "project" | "thread" | "time">("model");
  const [selectedEnvironmentIds, setSelectedEnvironmentIds] =
    useState<ReadonlySet<EnvironmentId> | null>(null);
  // A namespaced project key, null for work outside every project, undefined for all.
  const [projectFilter, setProjectFilter] = useState<string | null | undefined>(undefined);
  const { days: windowDays, custom: isCustomWindow, window } = windowSelection;
  const isPast24Hours = !isCustomWindow && windowDays === 1;
  const { merged, environments, selectedEnvironments, isPending, isPartial, refresh } = useUsage(
    window,
    selectedEnvironmentIds,
    projectFilter,
    breakdown === "thread",
  );
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

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
  const breakdownModels = useMemo(
    () =>
      breakdown === "model" && metric === "tokens"
        ? merged.models.toSorted(
            (left, right) => right.totalTokens - left.totalTokens || right.costUsd - left.costUsd,
          )
        : merged.models,
    [breakdown, merged.models, metric],
  );
  const breakdownProjects = useMemo(() => {
    const scoped =
      projectFilter === undefined
        ? merged.projects
        : merged.projects.filter((project) => project.projectKey === projectFilter);
    return metric === "tokens"
      ? scoped.toSorted(
          (left, right) => right.totalTokens - left.totalTokens || right.costUsd - left.costUsd,
        )
      : scoped;
  }, [merged.projects, metric, projectFilter]);
  const breakdownProjectCostUsd = useMemo(
    () => breakdownProjects.reduce((sum, project) => sum + project.costUsd, 0),
    [breakdownProjects],
  );
  const projectLabelsRef = useRef(new Map<string, string>());
  for (const project of merged.projects) {
    if (project.projectKey !== null && project.project !== null) {
      projectLabelsRef.current.set(project.projectKey, project.project);
    }
  }
  const selectedProjectLabel =
    projectFilter === undefined
      ? null
      : projectFilter === null
        ? "Outside projects"
        : (projectLabelsRef.current.get(projectFilter) ?? "Selected project");
  const activeProviders = useMemo(() => providersWithUsage(merged.providers), [merged.providers]);
  const timeValueColumnWidth = `${60 / (activeProviders.length + 2)}%`;
  // Session figures are per transcript directory; a project filter cannot
  // split them, so they only render unfiltered.
  const sessionsKnown = projectFilter === undefined;
  const onlyProject = merged.projects.length === 1 ? merged.projects[0] : undefined;
  // Unknown attribution remains in the overall totals but is absent from the
  // project list. Keep a lone known project selectable when that distinction
  // lets the user remove unknown usage from the page.
  const showProjectPicker =
    merged.projects.length > 1 ||
    projectFilter !== undefined ||
    (onlyProject !== undefined &&
      (onlyProject.totalTokens !== merged.totalTokens || onlyProject.costUsd !== merged.costUsd));

  const selectWindow = (days: number) => {
    setWindowSelection({
      days,
      custom: false,
      window: makeWindow(days, undefined, days === 1 ? "hour" : "day"),
    });
  };
  const selectCustomWindow = (sinceDay: string, untilDay: string) => {
    setWindowSelection({
      days: windowDays,
      custom: true,
      window: makeCustomWindow(sinceDay, untilDay),
    });
  };
  const refreshWindow = () => {
    if (showingLimits) {
      for (const [environmentId, presentation] of presentations) {
        if (selectedEnvironmentIds !== null && !selectedEnvironmentIds.has(environmentId)) continue;
        if (presentation.connection.phase === "connected" && presentation.serverConfig !== null) {
          void refreshProviders({ environmentId, input: {} });
        }
      }
      return;
    }
    // A custom range is a fixed span of past days; rescanning is all a
    // refresh can mean for it.
    if (isCustomWindow) {
      refresh();
      return;
    }
    const nextWindow = makeWindow(windowDays, undefined, isPast24Hours ? "hour" : "day");
    if (
      nextWindow.sinceDay !== window.sinceDay ||
      nextWindow.untilDay !== window.untilDay ||
      nextWindow.sinceTime !== window.sinceTime ||
      nextWindow.untilTime !== window.untilTime
    ) {
      setWindowSelection({ days: windowDays, custom: false, window: nextWindow });
    }
    refresh();
  };
  const windowLabel =
    isPast24Hours && window.sinceTime !== undefined && window.untilTime !== undefined
      ? `${formatDateTimeShort(window.sinceTime, window.timeZone)} to ${formatDateTimeShort(window.untilTime, window.timeZone)}`
      : `${formatDayShort(window.sinceDay)} to ${formatDayShort(window.untilDay)}`;
  const topbarContent = (
    <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 py-2 xl:flex">
      <WorkspaceBreadcrumb ariaLabel="Usage breadcrumb" className="col-span-2 min-w-0">
        <WorkspaceBreadcrumbItem>
          <h1>Usage</h1>
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator />
        <WorkspaceBreadcrumbItem current className="min-w-10">
          <UsageEnvironmentFilter
            environments={environments}
            selectedEnvironments={selectedEnvironments}
            selectedEnvironmentIds={selectedEnvironmentIds}
            onSelectionChange={setSelectedEnvironmentIds}
            showUsageStatus={!showingLimits}
            isPartial={isPartial}
            duplicateSources={merged.duplicateSources}
            staleEnvironments={merged.staleEnvironments}
          />
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      {!showingLimits ? (
        <span className="hidden min-w-0 truncate text-xs text-muted-foreground 2xl:block">
          {windowLabel}
        </span>
      ) : null}
      <div className="ms-auto hidden min-w-0 items-center justify-end gap-2 xl:flex">
        {showProjectPicker ? (
          <UsageProjectSelect
            projects={merged.projects}
            filter={projectFilter}
            selectedLabel={selectedProjectLabel}
            onChange={setProjectFilter}
          />
        ) : null}
        <ToggleGroup
          aria-label="Usage metric"
          variant="segmented"
          value={[metric]}
          onValueChange={(next) => {
            const value = next[0];
            if (isUsageMetric(value)) setMetric(value);
          }}
        >
          {METRIC_OPTIONS.map((option) => (
            <Toggle key={option.value} value={option.value}>
              {option.label}
            </Toggle>
          ))}
        </ToggleGroup>
        <UsageDateRangeInputs
          sinceDay={window.sinceDay}
          untilDay={window.untilDay}
          onChange={selectCustomWindow}
          disabled={showingLimits}
        />
        {/* The period does not apply to Limits, so it stays in place but
            disabled; unmounting it shifted the metric toggle ~300px. */}
        <ToggleGroup
          aria-label="Usage period"
          variant="segmented"
          value={isCustomWindow ? [] : [String(windowDays)]}
          disabled={showingLimits}
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
        <Button
          onClick={refreshWindow}
          aria-label={showingLimits ? "Refresh limits" : "Refresh usage"}
          size="icon-sm"
          variant="ghost"
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
      <div className="col-span-2 ms-auto flex min-w-0 items-center justify-end gap-1 xl:hidden">
        {showProjectPicker ? (
          <UsageProjectSelect
            projects={merged.projects}
            filter={projectFilter}
            selectedLabel={selectedProjectLabel}
            onChange={setProjectFilter}
          />
        ) : null}
        <Select
          value={metric}
          onValueChange={(value) => {
            if (isUsageMetric(value)) setMetric(value);
          }}
        >
          <SelectTrigger
            aria-label="Usage metric"
            size="compact"
            variant="ghost"
            className="w-auto min-w-0"
          >
            <SelectValue>
              {METRIC_OPTIONS.find((option) => option.value === metric)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {METRIC_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Select
          value={isCustomWindow ? "custom" : String(windowDays)}
          disabled={showingLimits}
          onValueChange={(value) => {
            if (value !== "custom" && value !== null) selectWindow(Number(value));
          }}
        >
          <SelectTrigger
            aria-label="Usage period"
            size="compact"
            variant="ghost"
            className="w-auto min-w-0"
          >
            <SelectValue>
              {isCustomWindow
                ? "Custom"
                : WINDOW_OPTIONS.find((option) => option.days === windowDays)?.label}
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
        <Button
          onClick={refreshWindow}
          aria-label={showingLimits ? "Refresh limits" : "Refresh usage"}
          size="icon-sm"
          variant="ghost"
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          {topbarContent}
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {!showingLimits ? (
              <UsageDateRangeInputs
                className="mb-4 flex-wrap xl:hidden"
                sinceDay={window.sinceDay}
                untilDay={window.untilDay}
                onChange={selectCustomWindow}
              />
            ) : null}
            {selectedEnvironments.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {environments.length === 0
                  ? `Connect an environment to see ${showingLimits ? "limits" : "usage"}.`
                  : `Select an environment to see ${showingLimits ? "limits" : "usage"}.`}
              </p>
            ) : showingLimits ? (
              <UsageLimitsSection selectedEnvironmentIds={selectedEnvironmentIds} />
            ) : isPending ? (
              <UsageSkeleton />
            ) : (
              <>
                <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
                  <div className="flex min-w-0 flex-col gap-5">
                    <div className="flex flex-col gap-1">
                      <span className="text-4xl font-semibold text-foreground tabular-nums">
                        {metric === "cost"
                          ? formatUsd(merged.costUsd)
                          : formatTokens(merged.totalTokens)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {(() => {
                          const scope = sessionsKnown
                            ? `${formatCount(merged.sessions)} sessions`
                            : (selectedProjectLabel ?? "Outside projects");
                          return metric === "cost"
                            ? `${scope} · local public-list estimate`
                            : scope;
                        })()}
                      </span>
                    </div>

                    {activeProviders.map((provider) => {
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
                                {sessionsKnown ? (
                                  <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground tabular-nums">
                                    {sessionLabel}
                                  </span>
                                ) : null}
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
                    <div className="flex items-baseline justify-between gap-3">
                      <h2 className="text-sm font-medium text-foreground">
                        {isPast24Hours ? "Hourly" : "Daily"}{" "}
                        {metric === "tokens" ? "processed tokens" : "cost"}
                      </h2>
                      {isPast24Hours ? null : (
                        <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
                          drag to zoom · double-click resets
                        </span>
                      )}
                    </div>
                    <UsageProviderChart
                      providers={activeProviders}
                      days={days}
                      daily={merged.daily}
                      hours={hours}
                      hourly={merged.hourly}
                      metric={metric}
                      referenceTime={window.untilTime}
                      resolution={isPast24Hours ? "hour" : "day"}
                      timeZone={window.timeZone}
                      {...(isPast24Hours
                        ? {}
                        : {
                            onZoomToDays: selectCustomWindow,
                            onResetZoom: () => selectWindow(windowDays),
                          })}
                    />
                  </div>
                </section>

                <section className="flex flex-col gap-2">
                  <h2 className="text-sm font-medium text-foreground">Totals</h2>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-6">
                    <Metric label="Processed tokens" value={formatTokens(merged.totalTokens)} />
                    <Metric label="Cached input" value={formatTokens(merged.cachedInputTokens)} />
                    <Metric
                      label="Uncached input"
                      value={formatTokens(merged.uncachedInputTokens)}
                    />
                    <Metric label="Output" value={formatTokens(merged.outputTokens)} />
                    <Metric
                      label="Cache writes, estimated"
                      value={
                        merged.costQuality.cacheWriteUsd === null
                          ? "Unavailable"
                          : formatUsd(merged.costQuality.cacheWriteUsd)
                      }
                      {...(merged.costUsd > 0 && merged.costQuality.cacheWriteUsd !== null
                        ? {
                            detail: `${formatPercent(merged.costQuality.cacheWriteUsd / merged.costUsd, 0)} of estimate · not an expiry measure`,
                          }
                        : {})}
                    />
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
                        if (
                          value === "model" ||
                          value === "project" ||
                          value === "thread" ||
                          value === "time"
                        ) {
                          setBreakdown(value);
                        }
                      }}
                    >
                      {(
                        [
                          { value: "model", label: "Model" },
                          { value: "project", label: "Project" },
                          { value: "thread", label: "Thread" },
                          { value: "time", label: isPast24Hours ? "Hour" : "Day" },
                        ] as const
                      ).map((option) => (
                        <Toggle key={option.value} value={option.value}>
                          {option.label}
                        </Toggle>
                      ))}
                    </ToggleGroup>
                  </div>

                  {breakdown === "thread" ? (
                    <UsageThreadTable
                      input={{
                        sinceDay: window.sinceDay,
                        untilDay: window.untilDay,
                        timeZone: window.timeZone,
                        ...(window.sinceTime === undefined ? {} : { sinceTime: window.sinceTime }),
                        ...(window.untilTime === undefined ? {} : { untilTime: window.untilTime }),
                        ...(projectFilter === undefined ? {} : { projectKey: projectFilter }),
                      }}
                      providerContributions={merged.providerContributions}
                      summaryFailedEnvironments={
                        environments.filter(
                          (environment) =>
                            (environment.error !== null ||
                              merged.staleEnvironments.includes(environment.environmentId)) &&
                            projectFilterForEnvironment(
                              projectFilter,
                              environment.environmentId,
                            ) !== "environment-mismatch:",
                        ).length
                      }
                    />
                  ) : breakdown === "project" ? (
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
                          <th className="py-2 font-normal">Project</th>
                          <th className="py-2 text-right font-normal">Cost</th>
                          <th className="py-2 text-right font-normal">Cache writes</th>
                          <th className="py-2 text-right font-normal">Share</th>
                          <th className="py-2 text-right font-normal">Tokens</th>
                        </tr>
                      </thead>
                      <tbody>
                        {breakdownProjects.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="py-6 text-center text-muted-foreground">
                              {merged.records === 0
                                ? "No activity in this window."
                                : "No project attribution in this window."}
                            </td>
                          </tr>
                        ) : (
                          breakdownProjects.map((project) => (
                            <tr
                              key={project.projectKey ?? "\0"}
                              className="border-b border-border/50 transition-colors hover:bg-muted/50"
                            >
                              <td className="py-2">
                                {project.project === null ? (
                                  <span className="text-muted-foreground">Outside projects</span>
                                ) : (
                                  <span className="block truncate text-foreground">
                                    {project.project}
                                  </span>
                                )}
                              </td>
                              <td className="py-2 text-right text-foreground tabular-nums">
                                {formatUsd(project.costUsd)}
                              </td>
                              <UsageCacheWriteCell
                                cacheWriteTokens={project.cacheWriteTokens}
                                cacheWriteUsd={project.cacheWriteUsd}
                              />
                              <td className="py-2 text-right text-muted-foreground tabular-nums">
                                {formatPercent(
                                  projectFilter === undefined
                                    ? project.costShare
                                    : breakdownProjectCostUsd === 0
                                      ? 0
                                      : project.costUsd / breakdownProjectCostUsd,
                                )}
                              </td>
                              <td className="py-2 text-right text-muted-foreground tabular-nums">
                                {formatTokens(project.totalTokens)}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  ) : breakdown === "model" ? (
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
                          <th className="py-2 font-normal">Model</th>
                          <th className="py-2 text-right font-normal">Cost</th>
                          <th className="py-2 text-right font-normal">Cache writes</th>
                          <th className="py-2 text-right font-normal">Share</th>
                          <th className="py-2 text-right font-normal">Tokens</th>
                        </tr>
                      </thead>
                      <tbody>
                        {breakdownModels.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="py-6 text-center text-muted-foreground">
                              No activity in this window.
                            </td>
                          </tr>
                        ) : (
                          breakdownModels.map((model) => (
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
                              <UsageCacheWriteCell
                                cacheWriteTokens={model.cacheWriteTokens}
                                cacheWriteUsd={model.cacheWriteUsd}
                              />
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
                    <table className="w-full table-fixed text-sm">
                      <colgroup>
                        <col className="w-2/5" />
                        {activeProviders.map((provider) => (
                          <col key={provider} style={{ width: timeValueColumnWidth }} />
                        ))}
                        <col style={{ width: timeValueColumnWidth }} />
                        <col style={{ width: timeValueColumnWidth }} />
                      </colgroup>
                      <thead>
                        <tr className="border-b border-border text-left text-xs text-muted-foreground">
                          <th className="py-2 font-normal">{isPast24Hours ? "Hour" : "Day"}</th>
                          {activeProviders.map((provider) => (
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
                            <td
                              colSpan={activeProviders.length + 3}
                              className="py-6 text-center text-muted-foreground"
                            >
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
                              {activeProviders.map((provider) => (
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
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

/**
 * Free date-range bounds beside the presets. Native date inputs; committing
 * either bound deselects every preset. Compact layouts render the same control
 * above the page content so custom ranges remain reachable without crowding
 * the header.
 */
function UsageDateRangeInputs({
  className,
  sinceDay,
  untilDay,
  onChange,
  disabled = false,
}: {
  readonly className?: string;
  readonly sinceDay: string;
  readonly untilDay: string;
  readonly onChange: (sinceDay: string, untilDay: string) => void;
  readonly disabled?: boolean;
}) {
  // The shared buffered-input hook preserves a focused draft across upstream
  // range changes and commits on both blur and Enter. Keep the hooks separate
  // so each bound can validate against the last committed opposite bound.
  const sinceInput = useCommitOnBlur(sinceDay, (next) => {
    const comparison = compareUsageDays(next, untilDay);
    if (comparison !== null && comparison <= 0) onChange(next, untilDay);
  });
  const untilInput = useCommitOnBlur(untilDay, (next) => {
    const comparison = compareUsageDays(sinceDay, next);
    if (comparison !== null && comparison <= 0) onChange(sinceDay, next);
  });
  const comparison = compareUsageDays(sinceInput.value, untilInput.value);
  const invalid = comparison === null || comparison > 0;
  const inputClassName =
    "[color-scheme:inherit] [&_[data-slot=input]::-webkit-calendar-picker-indicator]:opacity-50";

  return (
    <div
      className={cn(
        "flex w-fit items-center text-xs text-muted-foreground",
        segmentedControlGroupClassName,
        className,
      )}
    >
      <Input
        nativeInput
        type="date"
        size="segmented"
        variant="segmented"
        aria-label="From day"
        className={inputClassName}
        max={untilInput.value}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        {...sinceInput}
      />
      <span className="px-0.5">to</span>
      <Input
        nativeInput
        type="date"
        size="segmented"
        variant="segmented"
        aria-label="To day"
        className={inputClassName}
        min={sinceInput.value}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        {...untilInput}
      />
    </div>
  );
}

/**
 * Select values are plain strings, so the three filter states get distinct
 * encodings: sentinels for "all" and "outside", while attributed projects
 * already carry a namespaced stable key from the merge layer.
 */
const ALL_PROJECTS_VALUE = "all";
const OUTSIDE_PROJECTS_VALUE = "outside";
const PROJECT_VALUE_PREFIX = "p:";

function projectFilterValue(filter: string | null | undefined): string {
  if (filter === undefined) return ALL_PROJECTS_VALUE;
  if (filter === null) return OUTSIDE_PROJECTS_VALUE;
  return `${PROJECT_VALUE_PREFIX}${filter}`;
}

function projectFilterFromValue(value: string): string | null | undefined {
  if (value === OUTSIDE_PROJECTS_VALUE) return null;
  if (value.startsWith(PROJECT_VALUE_PREFIX)) return value.slice(PROJECT_VALUE_PREFIX.length);
  return undefined;
}

/** Narrows the whole page to one project's buckets. */
function UsageProjectSelect({
  projects,
  filter,
  selectedLabel,
  onChange,
}: {
  readonly projects: readonly ProjectTotals[];
  readonly filter: string | null | undefined;
  readonly selectedLabel: string | null;
  readonly onChange: (filter: string | null | undefined) => void;
}) {
  const label = filter === undefined ? "All projects" : (selectedLabel ?? "Selected project");
  return (
    <Select
      value={projectFilterValue(filter)}
      onValueChange={(value) => onChange(projectFilterFromValue(value ?? ""))}
    >
      <SelectTrigger
        aria-label="Project filter"
        size="compact"
        variant="ghost"
        className="w-auto max-w-48 min-w-0"
      >
        <SelectValue>
          <span className="truncate">{label}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem value={ALL_PROJECTS_VALUE}>All projects</SelectItem>
        {projects.map((project) =>
          project.project === null ? (
            <SelectItem key={OUTSIDE_PROJECTS_VALUE} value={OUTSIDE_PROJECTS_VALUE}>
              Outside projects
            </SelectItem>
          ) : (
            <SelectItem
              key={project.projectKey}
              value={`${PROJECT_VALUE_PREFIX}${project.projectKey}`}
            >
              {project.project}
            </SelectItem>
          ),
        )}
      </SelectPopup>
    </Select>
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

function Metric({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-base font-medium text-foreground tabular-nums">{value}</span>
      {detail === undefined ? null : (
        <span className="text-xs text-muted-foreground tabular-nums">{detail}</span>
      )}
    </div>
  );
}

/**
 * Explains failed or incompatible environments and deduplicated transcripts.
 * Shown inside the environment filter so arriving results do not move the page.
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
    <div className="flex flex-col gap-1 border-t border-border px-2 py-2 text-xs text-muted-foreground">
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

/** Environment selection and scan progress share a permanent header control. */
function UsageEnvironmentFilter({
  environments,
  selectedEnvironments,
  selectedEnvironmentIds,
  onSelectionChange,
  showUsageStatus,
  isPartial,
  duplicateSources,
  staleEnvironments,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly onSelectionChange: (ids: ReadonlySet<EnvironmentId> | null) => void;
  readonly showUsageStatus: boolean;
  readonly isPartial: boolean;
  readonly duplicateSources: readonly string[];
  readonly staleEnvironments: readonly string[];
}) {
  const [modelPricesOpen, setModelPricesOpen] = useState(false);
  const allSelected = selectedEnvironmentIds === null;
  const label = allSelected
    ? "All environments"
    : selectedEnvironments.length === 1
      ? selectedEnvironments[0]!.label
      : `${selectedEnvironments.length} environments`;
  const pendingCount = selectedEnvironments.filter(
    (environment) =>
      environment.error === null && (environment.isPending || environment.summary === null),
  ).length;
  const hasIssue =
    selectedEnvironments.some((environment) => environment.error !== null) ||
    staleEnvironments.length > 0;

  return (
    <>
      <Menu>
        <MenuTrigger className="group/usage-environment inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring">
          <span className="min-w-0 truncate">{label}</span>
          <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
            {showUsageStatus && pendingCount > 0 ? (
              <>
                <CircleDashedIcon className="size-3.5" aria-hidden />
                <span className="sr-only">
                  {pendingCount} {pendingCount === 1 ? "environment" : "environments"} still
                  scanning
                  {isPartial ? "; totals are partial" : ""}
                </span>
              </>
            ) : showUsageStatus && hasIssue ? (
              <CircleAlertIcon
                className="size-3.5 text-amber-600 dark:text-amber-400"
                aria-label="Some environments could not report usage"
              />
            ) : (
              <ChevronDownIcon
                className="size-3.5 opacity-0 transition-opacity group-hover/usage-environment:opacity-100 group-focus-visible/usage-environment:opacity-100 group-data-popup-open/usage-environment:opacity-100"
                aria-hidden
              />
            )}
          </span>
        </MenuTrigger>
        <MenuPopup align="start" className="w-80 max-w-[calc(100vw-2rem)]">
          <MenuCheckboxItem
            checked={allSelected}
            closeOnClick={false}
            onCheckedChange={(checked) => onSelectionChange(checked ? null : new Set())}
          >
            All environments
          </MenuCheckboxItem>
          <MenuSeparator />
          {environments.map((environment) => {
            const checked =
              selectedEnvironmentIds === null ||
              selectedEnvironmentIds.has(environment.environmentId);
            const status =
              environment.error !== null
                ? "Unavailable"
                : environment.summary !== null &&
                    !isCompatibleUsageContractVersion(
                      environment.summary.contractVersion,
                      USAGE_CONTRACT_VERSION,
                    )
                  ? "Update required"
                  : environment.summary === null
                    ? "Scanning…"
                    : environment.isPending
                      ? "Refreshing…"
                      : "Ready";
            return (
              <MenuCheckboxItem
                key={environment.environmentId}
                checked={checked}
                closeOnClick={false}
                className="grid-cols-[1rem_minmax(0,1fr)]"
                onCheckedChange={(nextChecked) => {
                  const next = new Set(selectedEnvironments.map((entry) => entry.environmentId));
                  if (nextChecked) next.add(environment.environmentId);
                  else next.delete(environment.environmentId);
                  onSelectionChange(next.size === environments.length ? null : next);
                }}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span className="min-w-0 flex-1 truncate">{environment.label}</span>
                  {showUsageStatus ? (
                    <span
                      className={cn(
                        "shrink-0 text-xs text-muted-foreground",
                        environment.error !== null && "text-destructive",
                      )}
                    >
                      {status}
                    </span>
                  ) : null}
                </span>
              </MenuCheckboxItem>
            );
          })}
          {environments.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">No environments connected.</p>
          ) : null}
          {showUsageStatus && isPartial ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              Totals are partial while selected environments scan.
            </p>
          ) : null}
          {showUsageStatus ? (
            <UsageCoverageNotice
              environments={selectedEnvironments}
              duplicateSources={duplicateSources}
              staleEnvironments={staleEnvironments}
            />
          ) : null}
          <MenuSeparator />
          <MenuItem onClick={() => setModelPricesOpen(true)}>
            <SlidersHorizontalIcon aria-hidden />
            Model prices
          </MenuItem>
        </MenuPopup>
      </Menu>
      {modelPricesOpen ? (
        <UsagePriceOverrides
          usage={environments}
          initialSelectedEnvironmentIds={selectedEnvironmentIds}
          onOpenChange={setModelPricesOpen}
        />
      ) : null}
    </>
  );
}

/**
 * Stand-in with the loaded page's shape, using the shared `Skeleton` bars so it
 * breathes with the same `animate-skeleton` pulse as every other loading state.
 * Replaced by results as soon as the first environment answers.
 */
function UsageSkeleton() {
  return (
    <>
      <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <Skeleton className="h-10 w-36" />
            <Skeleton className="h-4 w-32" />
          </div>
          {PROVIDER_ORDER.map((provider) => (
            <div key={provider} className="flex flex-col gap-1">
              <div className="flex min-h-5 items-center justify-between gap-4">
                <span className="flex items-center gap-2">
                  <Skeleton className="size-2 shrink-0 rounded-full" />
                  <Skeleton className="size-4 shrink-0 rounded-full" />
                  <Skeleton className="h-3.5 w-20" />
                </span>
                <Skeleton className="h-3.5 w-14" />
              </div>
              <Skeleton className="h-4 w-36" />
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <Skeleton className="h-5 w-24" />
          <div className="flex flex-col gap-1">
            <Skeleton className="ml-16 h-56 bg-muted-foreground/10" />
            <Skeleton className="ml-16 h-4 bg-muted-foreground/10" />
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-foreground">Totals</h2>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-6">
          {[
            "Processed tokens",
            "Cached input",
            "Uncached input",
            "Output",
            "Cache writes, estimated",
            "Cache savings",
          ].map((label) => (
            <div key={label} className="flex flex-col gap-0.5">
              <span className="text-xs text-muted-foreground">{label}</span>
              <Skeleton className="h-6 w-16" />
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">Breakdown</h2>
          <Skeleton className="h-7 w-28 rounded-lg" />
        </div>
        <Skeleton className="h-44 bg-muted-foreground/10" />
      </section>
    </>
  );
}
