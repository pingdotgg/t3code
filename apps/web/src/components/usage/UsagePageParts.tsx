import { ChatGptUsageButton } from "../settings/ChatGptUsageButton";
import { usesChatGptSharing } from "@t3tools/shared/usageLimits";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  ProviderDriverKind,
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageProviderKind,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { CircleAlertIcon, ChevronDownIcon, InfoIcon, SlidersHorizontalIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import {
  cursorKeychainAccessEnvironments,
  refreshUsageLimits,
} from "@t3tools/client-runtime/state/usage";
import {
  updatingProvidersLabel,
  usageEnvironmentProgress,
  usageLoadingState,
} from "@t3tools/client-runtime/state/usage-progress";

import {
  isCompatibleUsageContractVersion,
  isModelCostUnknown,
  type DailyTotals,
  type HourlyTotals,
  type MergedUsage,
} from "@t3tools/shared/usageMerge";

import { cn } from "../../lib/utils";
import { usePrimarySettings } from "../../hooks/useSettings";
import { resolveHour12 } from "../../timestampFormat";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentPresentations } from "../../state/presentation";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../../state/server";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { shortcutLabelForCommand } from "../../keybindings";
import { useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  enumerateDays,
  enumerateHourStarts,
  formatCount,
  formatDateTimeShort,
  formatDayShort,
  formatHourShort,
  formatPercent,
  formatTokens,
  formatUsageContractMismatch,
  formatUsd,
  makeWindow,
  usageSourceMessages,
} from "@t3tools/shared/usageFormat";
import { Button, InlineButton } from "../ui/button";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { AppRouteModal, AppRouteModalClose } from "../AppRouteModal";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { UsageLimitsSection } from "./UsageLimits";
import { UsagePriceOverrides } from "./UsagePriceOverrides";
import { UsageProviderChart } from "./UsageProviderChart";
import { SpeedPremium, UsageModelDialog } from "./UsageModelDialog";
import { UsageShareBar } from "./UsageShareBar";
import {
  costTypeSegments,
  modelShare,
  sortModelsByTokens,
  speedCostSegments,
  tokenTypeSegments,
} from "./usageBreakdown";
import {
  METRIC_OPTIONS,
  WINDOW_OPTIONS,
  resolveUsageShortcut,
  type UsageMetric,
} from "./usageShortcuts";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION, providersWithUsage } from "./usageProviders";
import {
  readUsagePagePreferences,
  saveUsagePagePreferences,
  type UsagePagePreferences,
} from "./usagePagePreferences";
import { CursorEnableRow, Metric, ProviderMark, figureClass, usageLoading } from "./UsagePage";

export function UsageOverview({
  merged,
  shownWindow,
  hour12,
  days,
  hours,
  showingKept,
  metric,
  selectedEnvironments,
  hiddenProviders,
  refreshingUsage,
  cursorAccessEnvironments,
  showChatGptSharing,
  onCursorEnabled,
  onSelectModel,
}: {
  readonly merged: MergedUsage;
  readonly shownWindow: UsageSummaryInput;
  readonly hour12: boolean;
  readonly days: readonly string[];
  readonly hours: readonly string[];
  readonly showingKept: boolean;
  readonly metric: "tokens" | "cost";
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly refreshingUsage: boolean;
  readonly cursorAccessEnvironments: readonly EnvironmentUsageStatus[];
  readonly showChatGptSharing: boolean;
  readonly onCursorEnabled: () => void;
  readonly onSelectModel: (key: string) => void;
}) {
  const [breakdown, setBreakdown] = useState<"model" | "time">("model");
  const shownHourly = shownWindow.resolution === "hour";
  const loading = usageLoading(showingKept, selectedEnvironments, refreshingUsage, hiddenProviders);
  // Copy the primitive; JSX reads of loading.partial would merge all derivations into one compiler cache
  // scope.
  const loadingPartial = loading.partial === true;
  const loadingProviders = new Set(
    PROVIDER_ORDER.filter((provider) => loading.everyProvider || loading.providers.has(provider)),
  );
  const providersWithData = new Set(providersWithUsage(merged.providers));
  // Only loading.providers excludes hidden providers without data. Filter a fresh array so the compiler can
  // cache independently.
  const activeProviders = [...PROVIDER_ORDER].filter(
    (provider) => providersWithData.has(provider) || loading.providers.has(provider),
  );
  const chartLoadingProviders = new Set(
    activeProviders.filter((provider) => loadingProviders.has(provider)),
  );
  const sourceMessages = usageSourceMessages(
    selectedEnvironments.flatMap(
      (environment) =>
        environment.summary?.sources.filter(
          (source) => !hiddenProviders.has(source.fingerprint.provider),
        ) ?? [],
    ),
  );
  const breakdownPeriods: readonly (DailyTotals | HourlyTotals)[] = (
    shownHourly ? merged.hourly : merged.daily
  ).toReversed();
  const breakdownModels =
    breakdown === "model" && metric === "tokens"
      ? sortModelsByTokens(merged.models)
      : merged.models;
  const breakdownPeak = breakdownModels.reduce(
    (peak, model) => Math.max(peak, metric === "tokens" ? model.totalTokens : model.costUsd),
    0,
  );
  const cursorInsertAt =
    Math.max(activeProviders.indexOf("codex"), activeProviders.indexOf("claude")) + 1;
  const summaryRows: ReadonlyArray<
    | { readonly kind: "usage"; readonly provider: UsageProviderKind }
    | { readonly kind: "enable"; readonly environment: EnvironmentUsageStatus }
  > = [
    ...activeProviders
      .slice(0, cursorInsertAt)
      .map((provider) => ({ kind: "usage" as const, provider })),
    ...cursorAccessEnvironments.map((environment) => ({ kind: "enable" as const, environment })),
    ...activeProviders
      .slice(cursorInsertAt)
      .map((provider) => ({ kind: "usage" as const, provider })),
  ];

  return (
    <div aria-busy={loadingPartial} className="flex flex-col gap-6">
      {sourceMessages.map((message) => (
        <p key={message} className="mb-4 text-sm text-muted-foreground">
          {message}
        </p>
      ))}
      <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex flex-col gap-1">
            <span
              className={cn(
                "text-4xl font-semibold text-foreground tabular-nums",
                figureClass(loadingPartial),
              )}
            >
              {metric === "cost" ? formatUsd(merged.costUsd) : formatTokens(merged.totalTokens)}
            </span>
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <span>
                <span className={figureClass(loadingPartial)}>
                  {formatCount(merged.sessions)} sessions
                </span>
                {metric === "cost" && " · API estimate"}
              </span>
              {metric === "cost" && merged.costQuality.unpricedShare > 0 && (
                <Popover>
                  <PopoverTrigger
                    openOnHover
                    render={<InlineButton tone="muted" />}
                    aria-label="Unpriced usage details"
                  >
                    <InfoIcon className="size-3" aria-hidden />
                  </PopoverTrigger>
                  <PopoverPopup side="top" tooltipStyle>
                    API estimate excludes {formatPercent(merged.costQuality.unpricedShare)} unpriced
                    records.
                  </PopoverPopup>
                </Popover>
              )}
            </span>
          </div>

          {showChatGptSharing ? (
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>ChatGPT shared usage</span>
              <ChatGptUsageButton size="xs" />
            </div>
          ) : null}

          {summaryRows.map((row) => {
            if (row.kind === "enable") {
              return (
                <CursorEnableRow
                  key={`enable:${row.environment.environmentId}`}
                  environmentId={row.environment.environmentId}
                  label={row.environment.label}
                  showEnvironment={selectedEnvironments.length > 1}
                  onEnabled={onCursorEnabled}
                />
              );
            }
            const provider = row.provider;
            const totals = merged.providers.find((entry) => entry.provider === provider);
            const share = metric === "cost" ? (totals?.costShare ?? 0) : (totals?.tokenShare ?? 0);
            const providerSessions = totals?.sessions ?? 0;
            const sessionLabel = `${formatCount(providerSessions)} ${
              providerSessions === 1 ? "session" : "sessions"
            }`;
            const providerLoading = loadingProviders.has(provider);
            const awaitingData = providerLoading && !providersWithData.has(provider);
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
                      <span className="truncate">{PROVIDER_PRESENTATION[provider].label}</span>
                      <span
                        className={cn(
                          "shrink-0 whitespace-nowrap text-2xs text-muted-foreground tabular-nums",
                          figureClass(providerLoading),
                          awaitingData && "invisible",
                        )}
                      >
                        {sessionLabel}
                      </span>
                    </span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-sm font-medium text-foreground tabular-nums",
                      figureClass(providerLoading),
                    )}
                  >
                    {awaitingData
                      ? "-"
                      : metric === "cost"
                        ? formatUsd(totals?.costUsd ?? 0)
                        : formatTokens(totals?.totalTokens ?? 0)}
                  </span>
                </div>
                <span
                  className={cn(
                    "text-xs text-muted-foreground",
                    figureClass(providerLoading),
                    awaitingData && "invisible",
                  )}
                >
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
            {shownHourly ? "Hourly" : "Daily"} {metric === "tokens" ? "processed tokens" : "cost"}
          </h2>
          <UsageProviderChart
            providers={activeProviders}
            loadingProviders={chartLoadingProviders}
            days={days}
            daily={merged.daily}
            hours={hours}
            hourly={merged.hourly}
            metric={metric}
            referenceTime={shownWindow.untilTime}
            resolution={shownHourly ? "hour" : "day"}
            timeZone={shownWindow.timeZone}
            hour12={hour12}
          />
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-foreground">Totals</h2>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
          <Metric
            loading={loadingPartial}
            label="Processed tokens"
            value={formatTokens(merged.totalTokens)}
          />
          <Metric
            loading={loadingPartial}
            label="Cached input"
            value={formatTokens(merged.cachedInputTokens)}
          />
          <Metric
            loading={loadingPartial}
            label="Uncached input"
            value={formatTokens(merged.uncachedInputTokens)}
          />
          <Metric
            loading={loadingPartial}
            label="Output"
            value={formatTokens(merged.outputTokens)}
          />
          <Metric
            loading={loadingPartial}
            label="Cache savings"
            value={formatUsd(merged.costQuality.cacheSavingsUsd)}
          />
        </div>
      </section>

      {merged.totalTokens > 0 ? (
        <section
          className={cn("grid gap-x-12 gap-y-8 lg:grid-cols-2", figureClass(loadingPartial))}
        >
          {metric === "tokens" ? (
            <UsageShareBar
              label="Tokens by type"
              segments={tokenTypeSegments(merged)}
              format={formatTokens}
            />
          ) : (
            <>
              <UsageShareBar
                label="Cost by type"
                segments={costTypeSegments(merged.categoryCost)}
                format={formatUsd}
              />
              {merged.speedCost.fast + merged.speedCost.ultrafast > 0 ? (
                <UsageShareBar
                  label="Cost by speed"
                  segments={speedCostSegments(merged.speedCost)}
                  format={formatUsd}
                  aside={<SpeedPremium premiumUsd={merged.speedCost.premium} />}
                />
              ) : null}
            </>
          )}
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">Breakdown</h2>
          <ToggleGroup
            aria-label="Usage breakdown"
            variant="segmented"
            value={[breakdown]}
            onValueChange={(next) => {
              const value = next[0];
              if (value === "model" || value === "time") setBreakdown(value);
            }}
          >
            {(
              [
                { value: "model", label: "Model" },
                { value: "time", label: shownHourly ? "Hour" : "Day" },
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
              <tr className="border-b border-border text-right text-xs text-muted-foreground">
                <th className="py-2 pr-3 text-left font-normal">#</th>
                <th className="w-full py-2 text-left font-normal">Model</th>
                <th className="py-2 pl-6 font-normal">Cost</th>
                <th className="hidden py-2 pl-6 font-normal sm:table-cell">Share</th>
                <th className="py-2 pl-6 font-normal">Tokens</th>
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
                breakdownModels.map((model, index) => {
                  const key = `${model.provider}:${model.model}`;
                  const value = metric === "tokens" ? model.totalTokens : model.costUsd;
                  const hasBar = value > 0 && breakdownPeak > 0;
                  const share = modelShare(model, metric === "tokens" ? "tokens" : "cost");
                  const rowFigures = figureClass(loadingProviders.has(model.provider));
                  return (
                    <tr
                      key={key}
                      className="relative border-b border-border/50 text-right whitespace-nowrap text-muted-foreground tabular-nums transition-colors hover:bg-muted/50 has-focus-visible:bg-muted/50"
                    >
                      <td className="py-2.5 pr-3 text-left text-xs">{index + 1}</td>
                      <td className="py-2.5 text-left whitespace-normal">
                        <button
                          type="button"
                          onClick={() => onSelectModel(key)}
                          className={cn(
                            "flex items-center gap-2 text-left text-foreground outline-none after:absolute after:inset-0",
                            !hasBar && "py-1",
                          )}
                        >
                          <ProviderMark provider={model.provider} className="size-3.5" />
                          {model.model}
                        </button>
                        {hasBar ? (
                          <div aria-hidden className={cn("mt-1.5 h-0.5 max-w-48", rowFigures)}>
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `max(0.5rem, ${(value / breakdownPeak) * 100}%)`,
                                backgroundColor: PROVIDER_PRESENTATION[model.provider].color,
                              }}
                            />
                          </div>
                        ) : null}
                      </td>
                      <td className={cn("py-2.5 pl-6 text-foreground", rowFigures)}>
                        {isModelCostUnknown(model) ? (
                          <span className="text-muted-foreground">Unpriced</span>
                        ) : (
                          formatUsd(model.costUsd)
                        )}
                      </td>
                      <td className={cn("hidden py-2.5 pl-6 sm:table-cell", rowFigures)}>
                        {share === null ? "" : formatPercent(share)}
                      </td>
                      <td className={cn("py-2.5 pl-6", rowFigures)}>
                        {formatTokens(model.totalTokens)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        ) : (
          <div
            className="overflow-x-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            role="region"
            aria-label="Usage breakdown by time"
            tabIndex={0}
          >
            <table className="w-full text-sm whitespace-nowrap">
              <colgroup>
                <col className="w-2/5" />
              </colgroup>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-2 font-normal">{shownHourly ? "Hour" : "Day"}</th>
                  {activeProviders.map((provider) => (
                    <th key={provider} className="py-2 pl-4 text-right font-normal">
                      {PROVIDER_PRESENTATION[provider].label}
                    </th>
                  ))}
                  <th className="py-2 pl-4 text-right font-normal">Total</th>
                  <th className="py-2 pl-4 text-right font-normal">Tokens</th>
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
                          ? formatHourShort(period.hourStart, shownWindow.timeZone, hour12)
                          : formatDayShort(period.day)}
                      </td>
                      {activeProviders.map((provider) => (
                        <td
                          key={provider}
                          className={cn(
                            "py-2 pl-4 text-right text-muted-foreground tabular-nums",
                            figureClass(loadingProviders.has(provider)),
                          )}
                        >
                          {formatUsd(period.byProvider.get(provider)?.costUsd ?? 0)}
                        </td>
                      ))}
                      <td
                        className={cn(
                          "py-2 pl-4 text-right text-foreground tabular-nums",
                          figureClass(loadingPartial),
                        )}
                      >
                        {formatUsd(period.costUsd)}
                      </td>
                      <td
                        className={cn(
                          "py-2 pl-4 text-right text-muted-foreground tabular-nums",
                          figureClass(loadingPartial),
                        )}
                      >
                        {formatTokens(period.totalTokens)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

