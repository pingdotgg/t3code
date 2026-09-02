import type { UsageProviderKind } from "@t3tools/contracts";
import { CheckIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import type { DailyTotals, HourlyTotals, ProjectTotals } from "@t3tools/shared/usageMerge";

import { isElectron } from "../../env";
import { useCommitOnBlur } from "../../hooks/useCommitOnBlur";
import { cn } from "../../lib/utils";
import { useUsage, type EnvironmentUsageStatus } from "../../state/usage";
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
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { UsageProviderChart, type UsageChartMetric } from "./UsageProviderChart";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION, providersWithUsage } from "./usageProviders";

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
  const [metric, setMetric] = useState<UsageChartMetric>("cost");
  const [breakdown, setBreakdown] = useState<"model" | "project" | "time">("model");
  // A namespaced project key, null for work outside every project, undefined for all.
  const [projectFilter, setProjectFilter] = useState<string | null | undefined>(undefined);
  const { days: windowDays, custom: isCustomWindow, window } = windowSelection;
  const isPast24Hours = !isCustomWindow && windowDays === 1;
  const { merged, environments, isPending, isPartial, refresh } = useUsage(window, projectFilter);

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
  // Only offer the picker once a second grouping exists; a lone group can
  // only ever filter to itself.
  const showProjectPicker = merged.projects.length > 1 || projectFilter !== undefined;

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
    // A custom range is a fixed span of past days; rescanning is all a
    // refresh can mean for it.
    if (isCustomWindow) {
      refresh();
      return;
    }
    const nextWindow = makeWindow(windowDays, undefined, isPast24Hours ? "hour" : "day");
    if (
      nextWindow.sinceDay === window.sinceDay &&
      nextWindow.untilDay === window.untilDay &&
      nextWindow.sinceTime === window.sinceTime &&
      nextWindow.untilTime === window.untilTime
    ) {
      refresh();
    } else {
      setWindowSelection({ days: windowDays, custom: false, window: nextWindow });
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
            if (value === "cost" || value === "tokens") setMetric(value);
          }}
        >
          {(["cost", "tokens"] as const).map((option) => (
            <Toggle key={option} value={option}>
              {option === "cost" ? "Cost" : "Tokens"}
            </Toggle>
          ))}
        </ToggleGroup>
        <UsageDateRangeInputs
          sinceDay={window.sinceDay}
          untilDay={window.untilDay}
          onChange={selectCustomWindow}
        />
        <ToggleGroup
          aria-label="Usage period"
          variant="segmented"
          value={isCustomWindow ? [] : [String(windowDays)]}
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
            if (value === "cost" || value === "tokens") setMetric(value);
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
        <Select
          value={isCustomWindow ? "custom" : String(windowDays)}
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
        <Button onClick={refreshWindow} aria-label="Refresh usage" size="icon-sm" variant="ghost">
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>{topbarContent}</WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            <UsageDateRangeInputs
              className="mb-4 flex-wrap lg:hidden"
              sinceDay={window.sinceDay}
              untilDay={window.untilDay}
              onChange={selectCustomWindow}
            />
            {settling ? (
              <>
                {environments.length > 1 ? <UsageDeviceStrip environments={environments} /> : null}
                <UsageSkeleton />
              </>
            ) : (
              <>
                <UsageCoverageNotice
                  environments={environments}
                  duplicateSources={merged.duplicateSources}
                  staleEnvironments={merged.staleEnvironments}
                />

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
                          return metric === "cost" ? `${scope} · API estimate` : scope;
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
                  <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
                    <Metric label="Processed tokens" value={formatTokens(merged.totalTokens)} />
                    <Metric label="Cached input" value={formatTokens(merged.cachedInputTokens)} />
                    <Metric
                      label="Uncached input"
                      value={formatTokens(merged.uncachedInputTokens)}
                    />
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
                        if (value === "model" || value === "project" || value === "time") {
                          setBreakdown(value);
                        }
                      }}
                    >
                      {(
                        [
                          { value: "model", label: "Model" },
                          { value: "project", label: "Project" },
                          { value: "time", label: isPast24Hours ? "Hour" : "Day" },
                        ] as const
                      ).map((option) => (
                        <Toggle key={option.value} value={option.value}>
                          {option.label}
                        </Toggle>
                      ))}
                    </ToggleGroup>
                  </div>

                  {breakdown === "project" ? (
                    <table className="w-full table-fixed text-sm">
                      <colgroup>
                        <col className="w-2/5" />
                        <col className="w-1/5" />
                        <col className="w-1/5" />
                        <col className="w-1/5" />
                      </colgroup>
                      <thead>
                        <tr className="border-b border-border text-left text-xs text-muted-foreground">
                          <th className="py-2 font-normal">Project</th>
                          <th className="py-2 text-right font-normal">Cost</th>
                          <th className="py-2 text-right font-normal">Share</th>
                          <th className="py-2 text-right font-normal">Tokens</th>
                        </tr>
                      </thead>
                      <tbody>
                        {breakdownProjects.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="py-6 text-center text-muted-foreground">
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
                        <col className="w-2/5" />
                        <col className="w-1/5" />
                        <col className="w-1/5" />
                        <col className="w-1/5" />
                      </colgroup>
                      <thead>
                        <tr className="border-b border-border text-left text-xs text-muted-foreground">
                          <th className="py-2 font-normal">Model</th>
                          <th className="py-2 text-right font-normal">Cost</th>
                          <th className="py-2 text-right font-normal">Share</th>
                          <th className="py-2 text-right font-normal">Tokens</th>
                        </tr>
                      </thead>
                      <tbody>
                        {breakdownModels.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="py-6 text-center text-muted-foreground">
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
}: {
  readonly className?: string;
  readonly sinceDay: string;
  readonly untilDay: string;
  readonly onChange: (sinceDay: string, untilDay: string) => void;
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
    "w-auto rounded-md transition-colors hover:bg-background/55 hover:text-foreground focus-within:bg-background focus-within:text-foreground focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-background has-aria-invalid:text-destructive focus-within:has-aria-invalid:ring-destructive/50 dark:hover:bg-input/32 dark:focus-within:bg-input/72 [&_[data-slot=input]]:h-6 [&_[data-slot=input]]:px-2.5 [&_[data-slot=input]]:leading-6 [&_[data-slot=input]]:pointer-coarse:h-8.5 [&_[data-slot=input]]:pointer-coarse:leading-8.5 [&_[data-slot=input]::-webkit-calendar-picker-indicator]:opacity-50";

  return (
    <div
      className={cn(
        "flex w-fit items-center gap-0.5 rounded-lg bg-input/40 p-0.5 text-xs text-muted-foreground",
        className,
      )}
    >
      <Input
        nativeInput
        unstyled
        type="date"
        size="compact"
        aria-label="From day"
        className={cn(inputClassName, "[color-scheme:inherit]")}
        max={untilInput.value}
        aria-invalid={invalid || undefined}
        {...sinceInput}
      />
      <span className="px-0.5">to</span>
      <Input
        nativeInput
        unstyled
        type="date"
        size="compact"
        aria-label="To day"
        className={cn(inputClassName, "[color-scheme:inherit]")}
        min={sinceInput.value}
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
function UsageSkeleton() {
  return (
    <>
      <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <div className="h-10 w-36 rounded-sm bg-muted" />
            <div className="h-4 w-32 rounded-sm bg-muted" />
          </div>
          {PROVIDER_ORDER.map((provider) => (
            <div key={provider} className="flex flex-col gap-1">
              <div className="flex min-h-5 items-center justify-between gap-4">
                <span className="flex items-center gap-2">
                  <span className="size-2 shrink-0 rounded-full bg-muted" />
                  <span className="size-4 shrink-0 rounded-full bg-muted" />
                  <div className="h-3.5 w-20 rounded-sm bg-muted" />
                </span>
                <div className="h-3.5 w-14 rounded-sm bg-muted" />
              </div>
              <div className="h-4 w-36 rounded-sm bg-muted" />
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <div className="h-5 w-24 rounded-sm bg-muted" />
          <div className="flex flex-col gap-1">
            <div className="ml-16 h-56 rounded-sm bg-muted/35" />
            <div className="ml-16 h-4 rounded-sm bg-muted/35" />
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
                <div className="h-6 w-16 rounded-sm bg-muted" />
              </div>
            ),
          )}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">Breakdown</h2>
          <div className="h-7 w-28 rounded-lg bg-input/40" />
        </div>
        <div className="h-44 rounded-sm bg-muted/35" />
      </section>
    </>
  );
}
