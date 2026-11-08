import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { ChatGptUsageSummary } from "./ChatGptUsageSummary";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { EnvironmentId, USAGE_CONTRACT_VERSION, type UsageProviderKind } from "@t3tools/contracts";
import { type RouteProp, useIsFocused, useRoute } from "@react-navigation/native";
import {
  updatingProvidersLabel,
  usageEnvironmentProgress,
  usageProgress,
} from "@t3tools/client-runtime/state/usage-progress";
import {
  enumerateDays,
  enumerateHourStarts,
  formatCount,
  formatDayShort,
  formatHourShort,
  formatPercent,
  formatTokens,
  formatUsageContractMismatch,
  formatUsageCost,
  formatUsd,
  ALL_USAGE_WINDOW_DAYS,
  makeWindow,
  usageSourceMessages,
} from "@t3tools/shared/usageFormat";
import {
  isCompatibleUsageContractVersion,
  isCursorCoverageGap,
  isModelCostUnknown,
  type DailyTotals,
  type MergedUsage,
} from "@t3tools/shared/usageMerge";
import { useRef, useState, type ReactNode } from "react";
import { RefreshControl, View } from "react-native";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useReduceMotionEnabled } from "../../lib/appState";
import { AppText as Text } from "../../components/ui/AppText";
import { useWorkspaceSettledContentWidth } from "../layout/workspace-content-width";
import { cn } from "../../lib/cn";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import { SettingsSection } from "../settings/components/SettingsSection";
import { UsageDailyChart } from "./UsageDailyChart";
import { toggleUsageEnvironment } from "./usageEnvironmentSelection";
import { useRefreshLimits } from "./UsageLimitsSection";
import { UsageLimitsSection } from "./UsageLimitsPooled";
import type { UsageChartMetric } from "./usageChartData";
import { PROVIDER_LABEL, useProviderColors, useUsageMixColors } from "./usageProviders";

type UsageView = UsageChartMetric | "limits";
const VIEW_OPTIONS = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
  { value: "limits", label: "Limits" },
] as const satisfies readonly { value: UsageView; label: string }[];

const WINDOW_OPTIONS = [
  { value: 1, label: "24h", accessibilityLabel: "Past 24 hours" },
  { value: 7, label: "7d", accessibilityLabel: "Past 7 days" },
  { value: 30, label: "30d", accessibilityLabel: "Past 30 days" },
  { value: 90, label: "90d", accessibilityLabel: "Past 90 days" },
  { value: ALL_USAGE_WINDOW_DAYS, label: "All", accessibilityLabel: "All time" },
] as const;

const CHART_HEIGHT = 180;
const WIDE_CHART_HEIGHT = 260;
// Below this the page keeps the phone's single column.
const WIDE_WIDTH = 600;
const MAX_CONTENT_WIDTH = 1080;
const providerLabel = (provider: UsageProviderKind) => PROVIDER_LABEL[provider];

export function UsageRouteScreen(props: { readonly workspace?: boolean }) {
  const route = useRoute<RouteProp<{ Usage: { tab?: string } | undefined }, "Usage">>();
  return <UsageScreen workspace={props.workspace} tabParam={route.params?.tab} />;
}

function UsageScreen(props: {
  readonly workspace?: boolean;
  readonly tabParam: string | undefined;
}) {
  const insets = useSafeAreaInsets();
  const [selection, setSelection] = useState(() => ({
    params: props.tabParam,
    view: (props.tabParam === "usage" ? "cost" : "limits") as UsageView,
  }));
  if (selection.params !== props.tabParam) {
    setSelection({
      params: props.tabParam,
      view: props.tabParam === "usage" ? "cost" : "limits",
    });
  }
  const { view } = selection;
  const setView = (view: UsageView) => setSelection({ params: props.tabParam, view });
  const [measuredWidth, setWidth] = useState(0);
  // A workspace pane knows its width in the render that resizes it; measuring lags a frame.
  const width = useWorkspaceSettledContentWidth() ?? measuredWidth;
  const wide = width >= WIDE_WIDTH;
  const [windowSelection, setWindowSelection] = useState(() => ({
    days: 30,
    window: makeWindow(30),
  }));
  const { days: windowDays, window } = windowSelection;
  const isPast24Hours = windowDays === 1;
  const [selectedEnvironmentIds, setSelectedEnvironmentIds] =
    useState<ReadonlySet<EnvironmentId> | null>(null);
  const { merged, environments, selectedEnvironments, isPending, isPartial, refresh } = useUsage(
    window,
    selectedEnvironmentIds,
  );
  const isFocused = useIsFocused();
  const limits = useRefreshLimits(selectedEnvironmentIds, isFocused && view === "limits");
  // An environment only contributes to the totals once it has answered and is
  // not excluded by a usage contract mismatch, so "nothing to show" is
  // distinguishable from "still scanning".
  const usableEnvironmentCount = selectedEnvironments.filter(
    (environment) =>
      environment.summary !== null &&
      !merged.contractMismatches.some(
        (mismatch) => mismatch.environmentId === environment.environmentId,
      ),
  ).length;
  const sourceMessages = usageSourceMessages(
    selectedEnvironments.flatMap((environment) => environment.summary?.sources ?? []),
  );
  const canReadDiagnostics = selectedEnvironments.some(
    (environment) => environment.canReadDiagnostics,
  );

  const days = enumerateDays(window.sinceDay, window.untilDay);
  const chartDays =
    isPast24Hours && window.sinceTime !== undefined && window.untilTime !== undefined
      ? enumerateHourStarts(window.sinceTime, window.untilTime)
      : days;
  const chartTotals: readonly DailyTotals[] = isPast24Hours
    ? merged.hourly.map((hour) => ({
        day: hour.hourStart,
        costUsd: hour.costUsd,
        totalTokens: hour.totalTokens,
        byProvider: hour.byProvider,
      }))
    : merged.daily;

  // The pull spinner tracks the explicit re-scan kicked off by pull-to-refresh.
  // The initial scan renders its own placeholder.
  const [refreshingUsage, setRefreshingUsage] = useState(false);
  const refreshingRef = useRef(false);
  const showingLimits = view === "limits";
  const metric: UsageChartMetric = view === "tokens" ? "tokens" : "cost";
  const progress = usageProgress(selectedEnvironments, {
    refreshing: refreshingUsage,
    providerLabel,
  });
  const selectWindow = (days: number) => {
    setWindowSelection({
      days,
      window: makeWindow(days, undefined, days === 1 ? "hour" : "day"),
    });
  };
  const refreshWindow = () => {
    if (refreshingRef.current) return;
    const nextWindow = makeWindow(windowDays, undefined, isPast24Hours ? "hour" : "day");
    if (
      nextWindow.sinceDay !== window.sinceDay ||
      nextWindow.untilDay !== window.untilDay ||
      nextWindow.sinceTime !== window.sinceTime ||
      nextWindow.untilTime !== window.untilTime
    ) {
      setWindowSelection({ days: windowDays, window: nextWindow });
    }
    refreshingRef.current = true;
    setRefreshingUsage(true);
    void refresh(nextWindow).finally(() => {
      refreshingRef.current = false;
      setRefreshingUsage(false);
    });
  };

  const chart = {
    merged,
    days: chartDays,
    daily: chartTotals,
    metric,
    sinceDay: window.sinceDay,
    untilDay: window.untilDay,
    isPast24Hours,
    timeZone: window.timeZone,
  };
  const providers = <ProviderSection merged={merged} metric={metric} compact={wide} />;

  const showEnvironmentFilter = environments.length > 0 || selectedEnvironmentIds !== null;
  const selectEnvironment = (value: string) => {
    if (value === "all") {
      setSelectedEnvironmentIds(null);
      return;
    }
    const id = EnvironmentId.make(value);
    setSelectedEnvironmentIds((selected) => toggleUsageEnvironment(selected, environments, id));
  };
  const environmentMenu = {
    title: "Filter usage environments",
    icon:
      selectedEnvironmentIds === null
        ? ("line.3.horizontal.decrease" as const)
        : ("line.3.horizontal.decrease.circle.fill" as const),
    items: [
      {
        id: "all",
        title: "All environments",
        selected: selectedEnvironmentIds === null,
        onPress: () => selectEnvironment("all"),
      },
      ...environments.map((environment) => ({
        id: environment.environmentId,
        title: environment.label,
        subtitle: usageEnvironmentStatus(environment, refreshingUsage),
        selected:
          selectedEnvironmentIds === null || selectedEnvironmentIds.has(environment.environmentId),
        onPress: () => selectEnvironment(environment.environmentId),
      })),
    ],
  };

  return (
    <SettingsScreen
      title="Usage"
      menus={showEnvironmentFilter ? [environmentMenu] : undefined}
      workspaceRoot={props.workspace}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        refreshControl={
          showingLimits || canReadDiagnostics ? (
            <RefreshControl
              refreshing={showingLimits ? limits.refreshing : refreshingUsage}
              onRefresh={showingLimits ? () => void limits.refresh() : refreshWindow}
            />
          ) : undefined
        }
      >
        <View className="w-full gap-6 self-center" style={{ maxWidth: MAX_CONTENT_WIDTH }}>
          {wide ? (
            <View className="flex-row items-center gap-3">
              {showingLimits ? (
                <View className="flex-1" />
              ) : (
                <SegmentedControl
                  options={WINDOW_OPTIONS}
                  selected={windowDays}
                  onSelect={selectWindow}
                  size="compact"
                  className="flex-1"
                />
              )}
              <SegmentedControl
                options={VIEW_OPTIONS}
                selected={view}
                onSelect={setView}
                size="compact"
                role="tab"
                className="w-60"
              />
            </View>
          ) : (
            <SegmentedControl
              options={VIEW_OPTIONS}
              selected={view}
              onSelect={setView}
              role="tab"
            />
          )}
          <Animated.View
            key={showingLimits ? "limits" : "usage"}
            entering={FadeIn.duration(160).reduceMotion(ReduceMotion.System)}
            className="gap-6"
          >
            {showingLimits ? (
              <UsageLimitsSection
                now={limits.now}
                failedLabels={limits.failedLabels}
                selectedEnvironmentIds={selectedEnvironmentIds}
                wide={wide}
              />
            ) : (
              <>
                {wide ? null : (
                  <SegmentedControl
                    options={WINDOW_OPTIONS}
                    selected={windowDays}
                    onSelect={selectWindow}
                    size="compact"
                  />
                )}
                <ChatGptUsageSummary selectedEnvironmentIds={selectedEnvironmentIds} />
                {/* Reports partial coverage, failures, stale servers, duplicate
                    transcript directories and missing pricing in one place. When
                    no selected environment grants usage, the body below already
                    explains each one. */}
                {canReadDiagnostics ? (
                  <UsageCoverageNotice
                    environments={selectedEnvironments}
                    merged={merged}
                    isPartial={isPartial}
                  />
                ) : null}
                {isPending || (usableEnvironmentCount === 0 && isPartial) ? (
                  <Text className="py-16 text-center text-base text-foreground-muted">
                    Scanning provider transcripts…
                  </Text>
                ) : selectedEnvironments.length === 0 ? (
                  <Text className="py-16 text-center text-base text-foreground-muted">
                    {environments.length === 0
                      ? "Connect an environment to see usage."
                      : "Select an environment to see usage."}
                  </Text>
                ) : !canReadDiagnostics ? (
                  <View className="gap-2 py-16">
                    {selectedEnvironments.map((environment) => (
                      <Text
                        key={environment.environmentId}
                        className="text-center text-base text-foreground-muted"
                      >
                        {selectedEnvironments.length > 1 ? `${environment.label}: ` : null}
                        {environment.error}
                      </Text>
                    ))}
                  </View>
                ) : usableEnvironmentCount === 0 ? (
                  <Text className="py-16 text-center text-base text-foreground-muted">
                    {selectedEnvironmentIds === null
                      ? "No connected environment could report usage."
                      : "The selected environments are unavailable for usage."}
                  </Text>
                ) : (
                  <>
                    {sourceMessages.map((message) => (
                      <Text key={message} className="text-sm text-foreground-muted">
                        {message}
                      </Text>
                    ))}
                    <UsageUpdating dimmed={progress.dimmed} label={progress.label}>
                      {wide ? (
                        <View className="flex-row gap-6">
                          <View className="w-72 gap-6">
                            <View className="rounded-[24px] border-continuous bg-grouped-card p-4">
                              <UsageSummary merged={merged} metric={metric} />
                            </View>
                            {providers}
                          </View>
                          <View className="min-w-0 flex-1">
                            <ChartCard
                              {...chart}
                              height={WIDE_CHART_HEIGHT}
                              fill
                              title={`${isPast24Hours ? "Hourly" : "Daily"} ${metric === "cost" ? "cost" : "processed tokens"}`}
                            />
                          </View>
                        </View>
                      ) : (
                        <>
                          <ChartCard {...chart} height={CHART_HEIGHT} />
                          {providers}
                        </>
                      )}
                      <TotalsSection
                        merged={merged}
                        isPast24Hours={isPast24Hours}
                        columns={width >= 900 ? 6 : wide ? 3 : 2}
                      />
                      <CostSection merged={merged} wide={wide} />
                      <ModelsSection merged={merged} metric={metric} columns={wide ? 2 : 1} />
                    </UsageUpdating>
                  </>
                )}
              </>
            )}
          </Animated.View>
        </View>
      </ScrollView>
    </SettingsScreen>
  );
}

function UsageUpdating({
  dimmed,
  label,
  children,
}: {
  readonly dimmed: boolean;
  readonly label: string | null;
  readonly children: ReactNode;
}) {
  const reduceMotion = useReduceMotionEnabled();
  // The delay keeps a quick refresh from flashing the content.
  const dimStyle = {
    opacity: dimmed ? 0.5 : 1,
    transitionProperty: "opacity",
    transitionDuration: reduceMotion ? 0 : 150,
    transitionDelay: dimmed ? 150 : 0,
  } as const;

  return (
    <View>
      <Animated.View style={dimStyle} className="gap-6" accessibilityState={{ busy: dimmed }}>
        {children}
      </Animated.View>
      {label !== null ? (
        <Animated.View
          entering={FadeIn.delay(150).duration(150).reduceMotion(ReduceMotion.System)}
          accessibilityLiveRegion="polite"
          pointerEvents="none"
          className="absolute right-4 top-4 h-5 max-w-[55%] flex-row items-center gap-1.5"
        >
          <AppActivityIndicator size="small" colorClassName="accent-adaptive-sky-600-400" />
          <Text className="shrink text-sm text-adaptive-sky-600-400" numberOfLines={1}>
            {label}
          </Text>
        </Animated.View>
      ) : null}
    </View>
  );
}

function ChartCard(props: {
  readonly merged: MergedUsage;
  readonly days: readonly string[];
  readonly daily: readonly DailyTotals[];
  readonly metric: UsageChartMetric;
  readonly sinceDay: string;
  readonly untilDay: string;
  readonly isPast24Hours: boolean;
  readonly timeZone: string;
  readonly height: number;
  /** Replaces the summary when it sits beside the chart. */
  readonly title?: string;
  /** Grows the chart past `height` to match a taller neighbouring column. */
  readonly fill?: boolean;
}) {
  const { merged, metric } = props;
  const colors = useProviderColors();
  const hasActivity = props.daily.some((period) => period.totalTokens > 0);
  const [fillHeight, setFillHeight] = useState(0);
  const height = props.fill ? Math.max(fillHeight, props.height) : props.height;
  const costUnavailable = merged.pricingStatus === "unavailable";
  const chart =
    metric === "cost" && costUnavailable ? (
      <View style={{ height }} className="items-center justify-center">
        <Text className="text-base text-foreground-muted">Cost unavailable</Text>
      </View>
    ) : hasActivity ? (
      <UsageDailyChart days={props.days} daily={props.daily} metric={metric} height={height} />
    ) : (
      <View style={{ height }} className="items-center justify-center">
        <Text className="text-base text-foreground-muted">No activity in this window.</Text>
      </View>
    );

  return (
    <View
      className={`gap-4 rounded-[24px] border-continuous bg-grouped-card p-4${props.fill ? " flex-1" : ""}`}
    >
      {props.title ? (
        <Text className="text-sm font-t3-medium text-foreground">{props.title}</Text>
      ) : (
        <UsageSummary merged={merged} metric={metric} />
      )}

      {props.fill ? (
        // Absolute so the measured slot can shrink again when the neighbour gets shorter.
        <View
          className="flex-1"
          style={{ minHeight: props.height }}
          onLayout={(event) => setFillHeight(event.nativeEvent.layout.height)}
        >
          <View className="absolute inset-0">{chart}</View>
        </View>
      ) : (
        chart
      )}

      <View className="gap-2">
        <View className="flex-row items-center justify-between">
          <Text className="text-xs text-foreground-tertiary">
            {props.isPast24Hours
              ? formatHourShort(props.days[0] ?? "", props.timeZone)
              : formatDayShort(props.sinceDay)}
          </Text>
          <Text className="text-xs text-foreground-tertiary">
            {props.isPast24Hours
              ? formatHourShort(props.days[props.days.length - 1] ?? "", props.timeZone)
              : formatDayShort(props.untilDay)}
          </Text>
        </View>
        <View className="flex-row flex-wrap items-center gap-x-4 gap-y-1">
          {merged.providers.map((provider) => (
            <View key={provider.provider} className="flex-row items-center gap-1.5">
              <View
                className="size-2 rounded-full"
                style={{ backgroundColor: colors[provider.provider] }}
              />
              <Text className="text-xs text-foreground-muted">
                {PROVIDER_LABEL[provider.provider]}
              </Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

function UsageSummary(props: { readonly merged: MergedUsage; readonly metric: UsageChartMetric }) {
  const { merged, metric } = props;
  const costUnavailable = merged.pricingStatus === "unavailable";
  return (
    <View className="gap-0.5">
      <Text className="text-sm text-foreground-muted">
        {metric === "cost" ? "Raw token cost" : "Processed tokens"}
      </Text>
      <Text className="text-4xl font-t3-bold tabular-nums text-foreground">
        {metric === "cost"
          ? costUnavailable
            ? formatUsageCost(merged.pricingStatus, merged.costUsd)
            : `${formatUsd(merged.costUsd)}*`
          : formatTokens(merged.totalTokens)}
      </Text>
      <Text className="text-sm text-foreground-muted">
        {metric === "cost"
          ? costUnavailable
            ? "Token counts are still valid."
            : "* if billed at full API rate"
          : `Across ${formatCount(merged.sessions)} sessions`}
      </Text>
    </View>
  );
}

function ProviderSection(props: {
  readonly merged: MergedUsage;
  readonly metric: UsageChartMetric;
  /** Drops the share bar so the list fits beside the chart. */
  readonly compact: boolean;
}) {
  const { merged, metric } = props;
  const colors = useProviderColors();
  if (merged.providers.length === 0) return null;
  const costUnavailable = merged.pricingStatus === "unavailable";

  // Hermes lacks toSorted.
  const ordered = [...merged.providers].sort((a, b) =>
    metric === "cost" && !costUnavailable ? b.costUsd - a.costUsd : b.totalTokens - a.totalTokens,
  );

  return (
    <SettingsSection title="Providers">
      {ordered.map((provider, index) => {
        const share =
          metric === "cost" && !costUnavailable ? provider.costShare : provider.tokenShare;
        return (
          <View
            key={provider.provider}
            className={cn(
              props.compact ? "gap-0.5 px-4 py-3" : "gap-2 p-4",
              index > 0 && "border-t border-border-subtle",
            )}
          >
            <View className="flex-row items-baseline justify-between gap-3">
              <View className="flex-row items-center gap-2">
                <View
                  className="size-2.5 rounded-full"
                  style={{ backgroundColor: colors[provider.provider] }}
                />
                <Text
                  className={
                    props.compact ? "text-base text-foreground" : "text-lg text-foreground"
                  }
                >
                  {PROVIDER_LABEL[provider.provider]}
                </Text>
              </View>
              <Text
                className={
                  props.compact
                    ? "text-base tabular-nums text-foreground"
                    : "text-lg tabular-nums text-foreground"
                }
              >
                {metric === "cost"
                  ? formatUsageCost(merged.pricingStatus, provider.costUsd)
                  : formatTokens(provider.totalTokens)}
              </Text>
            </View>
            {props.compact ? null : (
              <View className="h-1 flex-row overflow-hidden rounded-full bg-subtle">
                <View
                  className="h-full rounded-full"
                  style={{ flex: share, backgroundColor: colors[provider.provider] }}
                />
                <View style={{ flex: 1 - share }} />
              </View>
            )}
            <Text className="text-sm text-foreground-muted">
              {metric === "cost"
                ? costUnavailable
                  ? `${formatTokens(provider.totalTokens)} tokens`
                  : `${formatPercent(share)} of cost · ${formatTokens(provider.totalTokens)} tokens`
                : costUnavailable
                  ? `${formatPercent(share)} of tokens`
                  : `${formatPercent(share)} of tokens · ${formatUsd(provider.costUsd)}`}
            </Text>
          </View>
        );
      })}
    </SettingsSection>
  );
}

function TotalsSection(props: {
  readonly merged: MergedUsage;
  readonly isPast24Hours: boolean;
  readonly columns: number;
}) {
  const { merged } = props;
  const activePeriods = (props.isPast24Hours ? merged.hourly : merged.daily).filter(
    (period) => period.totalTokens > 0,
  ).length;
  const periodAverage = activePeriods === 0 ? 0 : merged.totalTokens / activePeriods;
  const observedInput = merged.uncachedInputTokens + merged.cachedInputTokens;
  const cachedShare = observedInput === 0 ? 0 : merged.cachedInputTokens / observedInput;

  return (
    <SettingsSection title="Totals">
      <View className="flex-row flex-wrap">
        <MetricCell
          columns={props.columns}
          label="Processed tokens"
          value={formatTokens(merged.totalTokens)}
          detail={`${formatTokens(periodAverage)} per active ${props.isPast24Hours ? "hour" : "day"}`}
        />
        <MetricCell
          columns={props.columns}
          label="Cache savings"
          value={formatUsageCost(merged.pricingStatus, merged.costQuality.cacheSavingsUsd)}
          detail={
            merged.pricingStatus === "unavailable"
              ? "requires the rate table"
              : merged.costUsd > 0
                ? `${(merged.costQuality.cacheSavingsUsd / merged.costUsd).toFixed(1)}x the raw cost`
                : "vs full input rates"
          }
        />
        <MetricCell
          columns={props.columns}
          label="Cached input"
          value={formatTokens(merged.cachedInputTokens)}
          detail={`${formatPercent(cachedShare)} of observed input`}
        />
        <MetricCell
          columns={props.columns}
          label="Uncached input"
          value={formatTokens(merged.uncachedInputTokens)}
          detail={`${formatTokens(merged.cacheCreationTokens)} cache writes`}
        />
        <MetricCell
          columns={props.columns}
          label="Output"
          value={formatTokens(merged.outputTokens)}
          detail={`incl. ${formatTokens(merged.reasoningTokens)} reasoning`}
        />
        <MetricCell
          columns={props.columns}
          label="Unpriced"
          value={formatPercent(merged.costQuality.unpricedShare)}
          detail="of records, excluded from cost"
        />
      </View>
    </SettingsSection>
  );
}

function CostSection(props: { readonly merged: MergedUsage; readonly wide: boolean }) {
  const { categoryCost, speedCost } = props.merged;
  const colors = useUsageMixColors();
  const byType = [
    { label: "Input", value: categoryCost.input, color: colors.input },
    { label: "Cache read", value: categoryCost.cacheRead, color: colors.cacheRead },
    { label: "Cache write", value: categoryCost.cacheWrite, color: colors.cacheWrite },
    { label: "Output", value: categoryCost.output, color: colors.output },
    // Reported cost with no rates to split it, or from older servers. Below a
    // cent it is rounding, not usage.
    {
      label: "Other",
      value: categoryCost.unsplit >= 0.005 ? categoryCost.unsplit : 0,
      color: colors.other,
    },
  ];
  const bySpeed = [
    { label: "Standard", value: speedCost.standard, color: colors.standard },
    { label: "Fast", value: speedCost.fast, color: colors.fast },
    { label: "Ultrafast", value: speedCost.ultrafast, color: colors.ultrafast },
  ];
  if (props.merged.costUsd <= 0) return null;

  return (
    <SettingsSection title="Cost">
      <View className={props.wide ? "flex-row" : undefined}>
        <View className={props.wide ? "min-w-0 flex-1" : undefined}>
          <ShareBar label="By type" segments={byType} />
        </View>
        {speedCost.fast + speedCost.ultrafast > 0 ? (
          <View
            className={
              props.wide
                ? "min-w-0 flex-1 border-l border-border-subtle"
                : "border-t border-border-subtle"
            }
          >
            <ShareBar
              label="By speed"
              segments={bySpeed}
              aside={`${formatUsd(speedCost.premium)} premium`}
            />
          </View>
        ) : null}
      </View>
    </SettingsSection>
  );
}

function ShareBar(props: {
  readonly label: string;
  readonly segments: readonly { label: string; value: number; color: string }[];
  readonly aside?: string;
}) {
  const visible = props.segments.filter((segment) => segment.value > 0);
  if (visible.length === 0) return null;

  return (
    <View className="gap-3 p-4">
      <View className="flex-row items-baseline justify-between gap-3">
        <Text className="text-sm text-foreground-muted">{props.label}</Text>
        {props.aside ? (
          <Text className="text-sm tabular-nums text-foreground-muted">{props.aside}</Text>
        ) : null}
      </View>
      <View className="h-2 flex-row gap-0.5">
        {visible.map((segment) => (
          <View
            key={segment.label}
            className="h-full rounded-sm"
            style={{ flex: segment.value, backgroundColor: segment.color }}
          />
        ))}
      </View>
      <View className="flex-row flex-wrap gap-x-4 gap-y-1.5">
        {visible.map((segment) => (
          <View key={segment.label} className="flex-row items-center gap-1.5">
            <View className="size-2 rounded-sm" style={{ backgroundColor: segment.color }} />
            <Text className="text-sm text-foreground-muted">{segment.label}</Text>
            <Text className="text-sm tabular-nums text-foreground">{formatUsd(segment.value)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function MetricCell(props: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly columns: number;
}) {
  return (
    <View className="gap-0.5 p-4" style={{ width: `${100 / props.columns}%` }}>
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <Text className="text-xl font-t3-medium tabular-nums text-foreground">{props.value}</Text>
      <Text className="text-xs text-foreground-tertiary">{props.detail}</Text>
    </View>
  );
}

function ModelsSection(props: {
  readonly merged: MergedUsage;
  readonly metric: UsageChartMetric;
  readonly columns: 1 | 2;
}) {
  const { merged, metric } = props;
  const colors = useProviderColors();
  if (merged.models.length === 0) return null;

  // Hermes lacks toSorted.
  const ordered = [...merged.models].sort((a, b) =>
    metric === "cost"
      ? b.costUsd - a.costUsd || b.totalTokens - a.totalTokens
      : b.totalTokens - a.totalTokens || b.costUsd - a.costUsd,
  );

  return (
    <SettingsSection title="By model">
      <View className="flex-row flex-wrap">
        {ordered.map((model, index) => (
          <View
            key={`${model.provider}:${model.model}`}
            className={cn(
              "flex-row items-center gap-3 p-4",
              index >= props.columns && "border-t border-border-subtle",
              index % props.columns === 1 && "border-l border-border-subtle",
            )}
            style={{ width: `${100 / props.columns}%` }}
          >
            <View
              className="size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: colors[model.provider] }}
            />
            <View className="min-w-0 flex-1 gap-0.5">
              <Text className="text-base text-foreground" numberOfLines={1}>
                {model.model}
              </Text>
              <Text className="text-sm text-foreground-muted">
                {metric === "tokens"
                  ? `${formatPercent(model.tokenShare)} of tokens · ${
                      isModelCostUnknown(model)
                        ? "no known rates"
                        : formatUsageCost(merged.pricingStatus, model.costUsd)
                    }`
                  : merged.pricingStatus === "unavailable"
                    ? formatTokens(model.totalTokens)
                    : isModelCostUnknown(model)
                      ? `no known rates · ${formatTokens(model.totalTokens)} tokens`
                      : `${formatPercent(model.costShare)} of cost · ${formatTokens(model.totalTokens)} tokens`}
              </Text>
            </View>
            <Text className="text-base tabular-nums text-foreground">
              {metric === "tokens"
                ? formatTokens(model.totalTokens)
                : merged.pricingStatus !== "unavailable" && isModelCostUnknown(model)
                  ? "Unpriced"
                  : formatUsageCost(merged.pricingStatus, model.costUsd)}
            </Text>
          </View>
        ))}
      </View>
    </SettingsSection>
  );
}

function usageEnvironmentStatus(environment: EnvironmentUsageStatus, refreshing: boolean): string {
  if (
    environment.summary &&
    !isCompatibleUsageContractVersion(environment.summary.contractVersion, USAGE_CONTRACT_VERSION)
  ) {
    return formatUsageContractMismatch(environment.label, {
      direction:
        environment.summary.contractVersion < USAGE_CONTRACT_VERSION
          ? "serverBehind"
          : "clientBehind",
    });
  }
  if (environment.error)
    return environment.summary ? `${environment.error} Showing saved totals.` : environment.error;
  if (!environment.isConnected)
    return environment.summary ? "Disconnected · showing saved usage" : "Waiting for connection…";
  const progress = usageEnvironmentProgress(environment, refreshing);
  if (progress.phase === "loading") return "Loading usage…";
  if (progress.phase === "stale") return "Updating usage…";
  if (progress.phase === "partway")
    return updatingProvidersLabel(progress.providers, providerLabel);
  return "Usage up to date";
}

/**
 * Says plainly when the totals are incomplete: an environment still answering,
 * one that failed, a Cursor soft-fail, or a transcript directory another
 * environment already reported. Claude/Codex missing homes stay quiet.
 */
function UsageCoverageNotice(props: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly merged: MergedUsage;
  readonly isPartial: boolean;
}) {
  const settling = props.environments.filter(
    (environment) => environment.phase === "connecting" || environment.phase === "reconnecting",
  );
  const unavailable = props.environments.filter(
    (environment) =>
      !environment.isPending &&
      (environment.phase === "available" ||
        environment.phase === "offline" ||
        environment.phase === "error"),
  );
  // A denied grant and a failed scan need different fixes, so each failure
  // states its reason. Environments already listed as settling or unavailable
  // are not repeated.
  const failed = props.environments.filter(
    (environment) =>
      environment.error !== null &&
      !settling.includes(environment) &&
      !unavailable.includes(environment),
  );
  const mismatchByEnvironment = new Map(
    props.merged.contractMismatches.map((mismatch) => [mismatch.environmentId, mismatch]),
  );
  const incompatible = props.environments.flatMap((environment) => {
    const mismatch = mismatchByEnvironment.get(environment.environmentId);
    return mismatch === undefined ? [] : [{ environment, mismatch }];
  });
  const duplicateSources = props.merged.duplicateSources;
  const uncovered = props.environments.flatMap((environment) => {
    if (environment.summary === null) return [];
    return environment.summary.sources.filter(isCursorCoverageGap).map((source) => ({
      key: `${environment.environmentId}:${source.fingerprint.provider}:${source.status}`,
      text: `${environment.label}: ${PROVIDER_LABEL[source.fingerprint.provider]} ${
        source.status === "missing" ? "is uncovered" : "could not be loaded"
      }${source.message ? ` (${source.message})` : ""}.`,
    }));
  });
  const costUnavailable = props.merged.pricingStatus === "unavailable";
  if (
    settling.length === 0 &&
    unavailable.length === 0 &&
    failed.length === 0 &&
    incompatible.length === 0 &&
    duplicateSources.length === 0 &&
    uncovered.length === 0 &&
    !props.isPartial &&
    !costUnavailable
  ) {
    return null;
  }

  return (
    <View className="gap-1 rounded-[16px] border-continuous bg-card px-4 py-3">
      {costUnavailable ? (
        <Text className="text-sm text-foreground-muted">
          The model rate table could not be loaded, so costs are omitted. Token counts are still
          valid.
        </Text>
      ) : null}
      {props.isPartial ? (
        <Text className="text-sm text-foreground-muted">
          Some environments are still reporting. Totals are partial.
        </Text>
      ) : null}
      {settling.map((environment) => (
        <Text key={environment.environmentId} className="text-sm text-foreground-muted">
          {environment.label} is {environment.phase}.
        </Text>
      ))}
      {unavailable.map((environment) => (
        <Text key={environment.environmentId} className="text-sm text-foreground-muted">
          {environment.label} is{" "}
          {environment.phase === "available"
            ? "not connected"
            : environment.phase === "error"
              ? "unavailable"
              : environment.phase}
          .
        </Text>
      ))}
      {failed.map((environment) => (
        <Text key={environment.environmentId} className="text-sm text-foreground-muted">
          {environment.label}: {environment.error}
        </Text>
      ))}
      {incompatible.map(({ environment, mismatch }) => (
        <Text key={environment.environmentId} className="text-sm text-foreground-muted">
          {formatUsageContractMismatch(environment.label, mismatch)}
        </Text>
      ))}
      {uncovered.map((entry) => (
        <Text key={entry.key} className="text-sm text-foreground-muted">
          {entry.text}
        </Text>
      ))}
      {duplicateSources.length > 0 ? (
        <Text className="text-sm text-foreground-muted">
          Counted once across environments sharing the same source: {duplicateSources.join(", ")}
        </Text>
      ) : null}
    </View>
  );
}
