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
  isCompatibleUsageContractVersion,
  isModelCostUnknown,
  type DailyTotals,
  type MergedUsage,
} from "@t3tools/shared/usageMerge";
import {
  enumerateDays,
  enumerateHourStarts,
  formatCount,
  formatPercent,
  formatTokens,
  formatUsd,
  makeWindow,
} from "@t3tools/shared/usageFormat";
import { formatUsageContractMismatch, usageSourceMessages } from "@t3tools/shared/usageFormatCopy";
import { msg, T, useGT, useLocale, useMessages, Var } from "gt-react-native";
import { use, useRef, useState, type ReactNode } from "react";
import { View } from "react-native";
import { RefreshControl } from "../../components/ui/RefreshControl";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useReduceMotionEnabled } from "../../lib/appState";
import { AppText as Text } from "../../components/ui/AppText";
import { useWorkspaceSettledContentWidth } from "../layout/workspace-content-width";
import { cn } from "../../lib/cn";
import type { MessageResolver } from "../../i18n/messages";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { NativeWorkspaceTabActivityContext } from "../../native/v5-workspace-context";
import { useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import { SettingsSection } from "../settings/components/SettingsSection";
import { usageAxisDayLabel, usageAxisHourLabel } from "./usageAxisLabels";
import { UsageDailyChart } from "./UsageDailyChart";
import { toggleUsageEnvironment } from "./usageEnvironmentSelection";
import { useRefreshLimits } from "./UsageLimitsSection";
import { UsageLimitsSection } from "./UsageLimitsPooled";
import type { UsageChartMetric } from "./usageChartData";
import { PROVIDER_LABEL, useProviderColors, useUsageMixColors } from "./usageProviders";

type UsageView = UsageChartMetric | "limits";
const VIEW_OPTIONS = [
  { value: "cost", label: msg("Cost", { $context: "usage view tab" }) },
  { value: "tokens", label: msg("Tokens", { $context: "usage view tab" }) },
  { value: "limits", label: msg("Limits", { $context: "usage view tab, subscription limits" }) },
] as const satisfies readonly { value: UsageView; label: string }[];

const WINDOW_OPTIONS = [
  {
    value: 1,
    label: msg("24h", { $context: "short label for the past 24 hours" }),
    accessibilityLabel: msg("Past 24 hours"),
  },
  {
    value: 7,
    label: msg("7d", { $context: "short label for the past 7 days" }),
    accessibilityLabel: msg("Past 7 days"),
  },
  {
    value: 30,
    label: msg("30d", { $context: "short label for the past 30 days" }),
    accessibilityLabel: msg("Past 30 days"),
  },
  {
    value: 90,
    label: msg("90d", { $context: "short label for the past 90 days" }),
    accessibilityLabel: msg("Past 90 days"),
  },
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
  const gt = useGT();
  const m = useMessages();
  const viewOptions = VIEW_OPTIONS.map((option) => ({ ...option, label: m(option.label) }));
  const windowOptions = WINDOW_OPTIONS.map((option) => ({
    ...option,
    label: m(option.label),
    accessibilityLabel: m(option.accessibilityLabel),
  }));
  const insets = useSafeAreaInsets();
  const headerOnly = use(NativeWorkspaceTabActivityContext)?.headerOnly === true;
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
  const { merged, environments, selectedEnvironments, isPending, refresh } = useUsage(
    window,
    selectedEnvironmentIds,
    !headerOnly,
  );
  const isFocused = useIsFocused();
  const limits = useRefreshLimits(
    selectedEnvironmentIds,
    isFocused && view === "limits" && !headerOnly,
  );
  const sourceMessages = usageSourceMessages(
    selectedEnvironments.flatMap((environment) => environment.summary?.sources ?? []),
    m,
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

  const [refreshingUsage, setRefreshingUsage] = useState(false);
  const refreshingRef = useRef(false);
  const showingLimits = view === "limits";
  const metric: UsageChartMetric = view === "tokens" ? "tokens" : "cost";
  const progress = usageProgress(
    selectedEnvironments,
    {
      refreshing: refreshingUsage,
      providerLabel,
    },
    m,
  );
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
    title: gt("Filter usage environments"),
    icon:
      selectedEnvironmentIds === null
        ? ("line.3.horizontal.decrease" as const)
        : ("line.3.horizontal.decrease.circle.fill" as const),
    items: [
      {
        id: "all",
        title: gt("All environments"),
        selected: selectedEnvironmentIds === null,
        onPress: () => selectEnvironment("all"),
      },
      ...environments.map((environment) => ({
        id: environment.environmentId,
        title: environment.label,
        subtitle: usageEnvironmentStatus(environment, refreshingUsage, m),
        selected:
          selectedEnvironmentIds === null || selectedEnvironmentIds.has(environment.environmentId),
        onPress: () => selectEnvironment(environment.environmentId),
      })),
    ],
  };

  return (
    <SettingsScreen
      title={gt("Usage", { $context: "screen title" })}
      menus={showEnvironmentFilter ? [environmentMenu] : undefined}
      workspaceRoot={props.workspace}
    >
      {headerOnly ? null : (
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
                    options={windowOptions}
                    selected={windowDays}
                    onSelect={selectWindow}
                    size="compact"
                    className="flex-1"
                  />
                )}
                <SegmentedControl
                  options={viewOptions}
                  selected={view}
                  onSelect={setView}
                  size="compact"
                  role="tab"
                  className="flex-1"
                />
              </View>
            ) : (
              <SegmentedControl
                options={viewOptions}
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
                      options={windowOptions}
                      selected={windowDays}
                      onSelect={selectWindow}
                      size="compact"
                    />
                  )}
                  <ChatGptUsageSummary selectedEnvironmentIds={selectedEnvironmentIds} />
                  {merged.duplicateSources.length > 0 ? (
                    <Text className="text-sm text-foreground-muted">
                      <T>
                        Counted once across environments sharing a transcript directory:{" "}
                        <Var>{merged.duplicateSources.join(", ")}</Var>
                      </T>
                    </Text>
                  ) : null}
                  {isPending ? (
                    <Text className="py-16 text-center text-base text-foreground-muted">
                      <T>Scanning provider transcripts…</T>
                    </Text>
                  ) : selectedEnvironments.length === 0 ? (
                    <Text className="py-16 text-center text-base text-foreground-muted">
                      {environments.length === 0
                        ? gt("Connect an environment to see usage.")
                        : gt("Select an environment to see usage.")}
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
                                title={
                                  isPast24Hours
                                    ? metric === "cost"
                                      ? gt("Hourly cost")
                                      : gt("Hourly processed tokens")
                                    : metric === "cost"
                                      ? gt("Daily cost")
                                      : gt("Daily processed tokens")
                                }
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
      )}
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
  const locale = useLocale();
  const hasActivity = props.daily.some((period) => period.totalTokens > 0);
  const [fillHeight, setFillHeight] = useState(0);
  const height = props.fill ? Math.max(fillHeight, props.height) : props.height;
  const chart = hasActivity ? (
    <UsageDailyChart days={props.days} daily={props.daily} metric={metric} height={height} />
  ) : (
    <View style={{ height }} className="items-center justify-center">
      <Text className="text-base text-foreground-muted">
        <T>No activity in this window.</T>
      </Text>
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
              ? usageAxisHourLabel(props.days[0] ?? "", locale, props.timeZone)
              : usageAxisDayLabel(props.sinceDay, locale)}
          </Text>
          <Text className="text-xs text-foreground-tertiary">
            {props.isPast24Hours
              ? usageAxisHourLabel(props.days[props.days.length - 1] ?? "", locale, props.timeZone)
              : usageAxisDayLabel(props.untilDay, locale)}
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
  const gt = useGT();
  return (
    <View className="gap-0.5">
      <Text className="text-sm text-foreground-muted">
        {metric === "cost" ? gt("Raw token cost") : gt("Processed tokens")}
      </Text>
      <Text className="text-4xl font-t3-bold tabular-nums text-foreground">
        {metric === "cost" ? `${formatUsd(merged.costUsd)}*` : formatTokens(merged.totalTokens)}
      </Text>
      <Text className="text-sm text-foreground-muted">
        {metric === "cost"
          ? gt("* if billed at full API rate")
          : gt(
              "{count, plural, one {Across {sessions} session} other {Across {sessions} sessions}}",
              {
                count: merged.sessions,
                sessions: formatCount(merged.sessions),
              },
            )}
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
  const gt = useGT();
  if (merged.providers.length === 0) return null;

  // Hermes lacks toSorted.
  const ordered = [...merged.providers].sort((a, b) =>
    metric === "cost" ? b.costUsd - a.costUsd : b.totalTokens - a.totalTokens,
  );

  return (
    <SettingsSection title={gt("Providers")}>
      {ordered.map((provider, index) => {
        const share = metric === "cost" ? provider.costShare : provider.tokenShare;
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
                  ? formatUsd(provider.costUsd)
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
                ? gt("{share} of cost · {tokens} tokens", {
                    share: formatPercent(share),
                    tokens: formatTokens(provider.totalTokens),
                  })
                : gt("{share} of tokens · {cost}", {
                    share: formatPercent(share),
                    cost: formatUsd(provider.costUsd),
                  })}
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
  const gt = useGT();
  const activePeriods = (props.isPast24Hours ? merged.hourly : merged.daily).filter(
    (period) => period.totalTokens > 0,
  ).length;
  const periodAverage = activePeriods === 0 ? 0 : merged.totalTokens / activePeriods;
  const observedInput = merged.uncachedInputTokens + merged.cachedInputTokens;
  const cachedShare = observedInput === 0 ? 0 : merged.cachedInputTokens / observedInput;

  return (
    <SettingsSection title={gt("Totals")}>
      <View className="flex-row flex-wrap">
        <MetricCell
          columns={props.columns}
          label={gt("Processed tokens")}
          value={formatTokens(merged.totalTokens)}
          detail={
            props.isPast24Hours
              ? gt("{tokens} per active hour", { tokens: formatTokens(periodAverage) })
              : gt("{tokens} per active day", { tokens: formatTokens(periodAverage) })
          }
        />
        <MetricCell
          columns={props.columns}
          label={gt("Cache savings")}
          value={formatUsd(merged.costQuality.cacheSavingsUsd)}
          detail={
            merged.costUsd > 0
              ? gt("{ratio}x the raw cost", {
                  ratio: (merged.costQuality.cacheSavingsUsd / merged.costUsd).toFixed(1),
                })
              : gt("vs full input rates", {
                  $context:
                    "detail under the cache savings amount, compared with full input prices",
                })
          }
        />
        <MetricCell
          columns={props.columns}
          label={gt("Cached input")}
          value={formatTokens(merged.cachedInputTokens)}
          detail={gt("{share} of observed input", { share: formatPercent(cachedShare) })}
        />
        <MetricCell
          columns={props.columns}
          label={gt("Uncached input")}
          value={formatTokens(merged.uncachedInputTokens)}
          detail={gt("{tokens} cache writes", { tokens: formatTokens(merged.cacheCreationTokens) })}
        />
        <MetricCell
          columns={props.columns}
          label={gt("Output", { $context: "output tokens" })}
          value={formatTokens(merged.outputTokens)}
          detail={gt("incl. {tokens} reasoning", { tokens: formatTokens(merged.reasoningTokens) })}
        />
        <MetricCell
          columns={props.columns}
          label={gt("Unpriced", { $context: "share of usage records with no known price" })}
          value={formatPercent(merged.costQuality.unpricedShare)}
          detail={gt("of records, excluded from cost", {
            $context: "detail under a percentage of usage records that have no known price",
          })}
        />
      </View>
    </SettingsSection>
  );
}

function CostSection(props: { readonly merged: MergedUsage; readonly wide: boolean }) {
  const { categoryCost, speedCost } = props.merged;
  const colors = useUsageMixColors();
  const gt = useGT();
  const byType = [
    {
      label: gt("Input", { $context: "input tokens" }),
      value: categoryCost.input,
      color: colors.input,
    },
    { label: gt("Cache read"), value: categoryCost.cacheRead, color: colors.cacheRead },
    { label: gt("Cache write"), value: categoryCost.cacheWrite, color: colors.cacheWrite },
    {
      label: gt("Output", { $context: "output tokens" }),
      value: categoryCost.output,
      color: colors.output,
    },
    // Reported cost with no rates to split it, or from older servers. Below a
    // cent it is rounding, not usage.
    {
      label: gt("Other", { $context: "cost category" }),
      value: categoryCost.unsplit >= 0.005 ? categoryCost.unsplit : 0,
      color: colors.other,
    },
  ];
  const bySpeed = [
    {
      label: gt("Standard", { $context: "model speed tier" }),
      value: speedCost.standard,
      color: colors.standard,
    },
    {
      label: gt("Fast", { $context: "model speed tier" }),
      value: speedCost.fast,
      color: colors.fast,
    },
    {
      label: gt("Ultrafast", { $context: "model speed tier" }),
      value: speedCost.ultrafast,
      color: colors.ultrafast,
    },
  ];
  if (props.merged.costUsd <= 0) return null;

  return (
    <SettingsSection title={gt("Cost", { $context: "section heading" })}>
      <View className={props.wide ? "flex-row" : undefined}>
        <View className={props.wide ? "min-w-0 flex-1" : undefined}>
          <ShareBar label={gt("By type")} segments={byType} />
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
              label={gt("By speed")}
              segments={bySpeed}
              aside={gt("{cost} premium", { cost: formatUsd(speedCost.premium) })}
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
  const gt = useGT();
  if (merged.models.length === 0) return null;

  // Hermes lacks toSorted.
  const ordered = [...merged.models].sort((a, b) =>
    metric === "cost"
      ? b.costUsd - a.costUsd || b.totalTokens - a.totalTokens
      : b.totalTokens - a.totalTokens || b.costUsd - a.costUsd,
  );

  return (
    <SettingsSection title={gt("By model")}>
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
                  ? isModelCostUnknown(model)
                    ? gt("{share} of tokens · no known rates", {
                        share: formatPercent(model.tokenShare),
                      })
                    : gt("{share} of tokens · {cost}", {
                        share: formatPercent(model.tokenShare),
                        cost: formatUsd(model.costUsd),
                      })
                  : isModelCostUnknown(model)
                    ? gt("no known rates · {tokens} tokens", {
                        tokens: formatTokens(model.totalTokens),
                      })
                    : gt("{share} of cost · {tokens} tokens", {
                        share: formatPercent(model.costShare),
                        tokens: formatTokens(model.totalTokens),
                      })}
              </Text>
            </View>
            <Text className="text-base tabular-nums text-foreground">
              {metric === "tokens"
                ? formatTokens(model.totalTokens)
                : isModelCostUnknown(model)
                  ? gt("Unpriced", { $context: "model with no known price" })
                  : formatUsd(model.costUsd)}
            </Text>
          </View>
        ))}
      </View>
    </SettingsSection>
  );
}

function usageEnvironmentStatus(
  environment: EnvironmentUsageStatus,
  refreshing: boolean,
  resolve: MessageResolver,
): string {
  if (
    environment.summary &&
    !isCompatibleUsageContractVersion(environment.summary.contractVersion, USAGE_CONTRACT_VERSION)
  ) {
    return formatUsageContractMismatch(
      environment.label,
      {
        direction:
          environment.summary.contractVersion < USAGE_CONTRACT_VERSION
            ? "serverBehind"
            : "clientBehind",
      },
      resolve,
    );
  }
  if (environment.error)
    return environment.summary
      ? resolve(msg("{error} Showing saved totals.", { error: environment.error }))
      : environment.error;
  if (!environment.isConnected)
    return environment.summary
      ? resolve(msg("Disconnected · showing saved usage"))
      : resolve(msg("Waiting for connection…"));
  const progress = usageEnvironmentProgress(environment, refreshing);
  if (progress.phase === "loading") return resolve(msg("Loading usage…"));
  if (progress.phase === "stale") return resolve(msg("Updating usage…"));
  if (progress.phase === "partway")
    return updatingProvidersLabel(progress.providers, providerLabel, resolve);
  return resolve(msg("Usage up to date"));
}
