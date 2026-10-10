import { ChatGptUsageSummary } from "./ChatGptUsageSummary";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { EnvironmentId, USAGE_CONTRACT_VERSION, type UsageProviderKind } from "@t3tools/contracts";
import { type RouteProp, useIsFocused, useNavigation, useRoute } from "@react-navigation/native";
import { cursorKeychainAccessEnvironments } from "@t3tools/client-runtime/state/usage";
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
  formatDayShort,
  formatHourShort,
  formatPercent,
  formatTokens,
  formatUsageContractMismatch,
  formatUsd,
  makeWindow,
} from "@t3tools/shared/usageFormat";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Platform, Pressable, RefreshControl, View } from "react-native";
import Animated, {
  FadeIn,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SegmentedControl } from "../../components/SegmentedControl";
import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import { UsageDailyChart } from "./UsageDailyChart";
import { toggleUsageEnvironment } from "./usageEnvironmentSelection";
import { useRefreshLimits } from "./UsageLimitsSection";
import { UsageLimitsSection } from "./UsageLimitsPooled";
import { ControlPillMenu } from "../../components/ControlPill";
import { SymbolView } from "../../components/AppSymbol";
import type { UsageChartMetric } from "./usageChartData";
import { PROVIDER_LABEL, useProviderColors, useUsageMixColors } from "./usageProviders";

type UsageTab = "usage" | "limits";
const TAB_OPTIONS = [
  { value: "usage", label: "Usage" },
  { value: "limits", label: "Limits" },
] as const satisfies readonly { value: UsageTab; label: string }[];

// Labels are abbreviated to share a row with the metric toggle; screen
// readers get the full phrase.
const WINDOW_OPTIONS = [
  { value: 1, label: "24h", accessibilityLabel: "Past 24 hours" },
  { value: 7, label: "7d", accessibilityLabel: "Past 7 days" },
  { value: 30, label: "30d", accessibilityLabel: "Past 30 days" },
  { value: 90, label: "90d", accessibilityLabel: "Past 90 days" },
] as const;

const METRIC_OPTIONS = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
] as const satisfies readonly { value: UsageChartMetric; label: string }[];

const CHART_HEIGHT = 180;
const providerLabel = (provider: UsageProviderKind) => PROVIDER_LABEL[provider];
const CURSOR_KEYCHAIN_COPY = "Requires access to your Cursor login in macOS Keychain.";

/**
 * Two tabs over one screen. Usage is the transcript-derived spend for a
 * period; Limits is the live subscription quota, which has no period. Both
 * pull to refresh, each refreshing its own data.
 */
export function UsageRouteScreen() {
  const route = useRoute<RouteProp<{ Usage: { tab?: string } | undefined }, "Usage">>();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  // Preserve the Limits default while honoring explicit widget/navigation links.
  const [selection, setSelection] = useState(() => ({
    params: route.params,
    tab: (route.params?.tab === "usage" ? "usage" : "limits") as UsageTab,
  }));
  if (selection.params !== route.params) {
    setSelection({
      params: route.params,
      tab: route.params?.tab === "usage" ? "usage" : "limits",
    });
  }
  const { tab } = selection;
  const setTab = (tab: UsageTab) => setSelection({ params: route.params, tab });
  const [windowSelection, setWindowSelection] = useState(() => ({
    days: 30,
    window: makeWindow(30),
  }));
  const [metric, setMetric] = useState<UsageChartMetric>("cost");
  const { days: windowDays, window } = windowSelection;
  const isPast24Hours = windowDays === 1;
  const [selectedEnvironmentIds, setSelectedEnvironmentIds] =
    useState<ReadonlySet<EnvironmentId> | null>(null);
  const { merged, environments, selectedEnvironments, isPending, refresh } = useUsage(
    window,
    selectedEnvironmentIds,
  );
  const isFocused = useIsFocused();
  const limits = useRefreshLimits(selectedEnvironmentIds, isFocused && tab === "limits");
  const cursorAccessEnvironments = cursorKeychainAccessEnvironments(selectedEnvironments);
  const refreshAfterCursorEnable = () => {
    void refresh();
    void limits.refreshAfterEnable();
  };
  const sourceMessages = [
    ...new Set(
      selectedEnvironments.flatMap(
        (environment) =>
          environment.summary?.sources.flatMap((source) =>
            source.message &&
            !source.action &&
            (source.status === "partial" ||
              source.status === "failed" ||
              source.fingerprint.provider === "cursor")
              ? [source.message]
              : [],
          ) ?? [],
      ),
    ),
  ];
  const canReadDiagnostics = selectedEnvironments.some(
    (environment) => environment.canReadDiagnostics,
  );

  const days = useMemo(
    () => enumerateDays(window.sinceDay, window.untilDay),
    [window.sinceDay, window.untilDay],
  );
  const chartDays = useMemo(
    () =>
      isPast24Hours && window.sinceTime !== undefined && window.untilTime !== undefined
        ? enumerateHourStarts(window.sinceTime, window.untilTime)
        : days,
    [days, isPast24Hours, window.sinceTime, window.untilTime],
  );
  const chartTotals = useMemo(
    (): readonly DailyTotals[] =>
      isPast24Hours
        ? merged.hourly.map((hour) => ({
            day: hour.hourStart,
            costUsd: hour.costUsd,
            totalTokens: hour.totalTokens,
            byProvider: hour.byProvider,
          }))
        : merged.daily,
    [isPast24Hours, merged.daily, merged.hourly],
  );

  const [refreshingUsage, setRefreshingUsage] = useState(false);
  const refreshingRef = useRef(false);
  const showingLimits = tab === "limits";
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

  const showEnvironmentFilter = environments.length > 0 || selectedEnvironmentIds !== null;
  const filterIcon =
    selectedEnvironmentIds === null
      ? "line.3.horizontal.decrease"
      : "line.3.horizontal.decrease.circle.fill";
  const environmentActions = useMemo(
    () => [
      {
        id: "all",
        title: "All environments",
        subtitle: undefined,
        state: selectedEnvironmentIds === null ? ("on" as const) : ("off" as const),
      },
      ...environments.map((environment) => ({
        id: environment.environmentId,
        title: environment.label,
        subtitle: usageEnvironmentStatus(environment, refreshingUsage),
        state:
          selectedEnvironmentIds === null || selectedEnvironmentIds.has(environment.environmentId)
            ? ("on" as const)
            : ("off" as const),
      })),
    ],
    [environments, refreshingUsage, selectedEnvironmentIds],
  );
  const selectEnvironment = useCallback(
    (value: string) => {
      if (value === "all") {
        setSelectedEnvironmentIds(null);
        return;
      }
      const id = EnvironmentId.make(value);
      setSelectedEnvironmentIds((selected) => toggleUsageEnvironment(selected, environments, id));
    },
    [environments],
  );
  const environmentFilter = useMemo(
    () =>
      showEnvironmentFilter ? (
        <ControlPillMenu
          accessible
          accessibilityRole="button"
          accessibilityLabel="Filter usage environments"
          title="Environments"
          actions={environmentActions}
          onPressAction={({ nativeEvent }) => selectEnvironment(nativeEvent.event)}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Filter usage environments"
            className={cn(
              "items-center justify-center rounded-full",
              Platform.OS === "ios" ? "size-[28px]" : "size-[44px]",
            )}
          >
            <SymbolView name={filterIcon} size={22} tintColorClassName="accent-icon" />
          </Pressable>
        </ControlPillMenu>
      ) : null,
    [showEnvironmentFilter, environmentActions, selectEnvironment, filterIcon],
  );

  useLayoutEffect(() => {
    if (Platform.OS === "ios") {
      navigation.setOptions({ headerRight: () => environmentFilter });
    }
  }, [navigation, environmentFilter]);

  return (
    <SettingsScreen title="Usage" trailing={environmentFilter}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          showingLimits || canReadDiagnostics ? (
            <RefreshControl
              refreshing={showingLimits ? limits.refreshing : refreshingUsage}
              onRefresh={showingLimits ? () => void limits.refresh() : refreshWindow}
            />
          ) : undefined
        }
      >
        <SegmentedControl options={TAB_OPTIONS} selected={tab} onSelect={setTab} role="tab" />
        <Animated.View
          key={tab}
          entering={FadeIn.duration(160).reduceMotion(ReduceMotion.System)}
          className="gap-6"
        >
          {showingLimits ? (
            <UsageLimitsSection
              now={limits.now}
              failedLabels={limits.failedLabels}
              selectedEnvironmentIds={selectedEnvironmentIds}
              cursorPrompt={
                cursorAccessEnvironments.length > 0 ? (
                  <CursorEnableLimits
                    environments={cursorAccessEnvironments}
                    onEnabled={refreshAfterCursorEnable}
                  />
                ) : null
              }
            />
          ) : (
            <>
              {/* Period and metric together: neither applies to Limits, and
                both change every number below, so they share one bar. */}
              <View className="gap-3 ios:flex-row ios:items-center">
                <SegmentedControl
                  options={WINDOW_OPTIONS}
                  selected={windowDays}
                  onSelect={selectWindow}
                  size="compact"
                  className="w-full ios:flex-1"
                />
                <SegmentedControl
                  options={METRIC_OPTIONS}
                  selected={metric}
                  onSelect={setMetric}
                  size="compact"
                  className="w-full ios:w-36"
                />
              </View>
              <ChatGptUsageSummary selectedEnvironmentIds={selectedEnvironmentIds} />
              {merged.duplicateSources.length > 0 ? (
                <Text className="text-sm text-foreground-muted">
                  Counted once across environments sharing a transcript directory:{" "}
                  {merged.duplicateSources.join(", ")}
                </Text>
              ) : null}
              {isPending ? (
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
                // Each environment explains itself: a denied grant and a failed
                // access check are different problems.
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
                    <ChartCard
                      merged={merged}
                      days={chartDays}
                      daily={chartTotals}
                      metric={metric}
                      sinceDay={window.sinceDay}
                      untilDay={window.untilDay}
                      isPast24Hours={isPast24Hours}
                      timeZone={window.timeZone}
                    />
                    <ProviderSection
                      merged={merged}
                      metric={metric}
                      cursorAccessEnvironments={cursorAccessEnvironments}
                      showCursorEnvironment={selectedEnvironments.length > 1}
                      onCursorEnabled={refreshAfterCursorEnable}
                    />
                    <TotalsSection merged={merged} isPast24Hours={isPast24Hours} />
                    <CostSection merged={merged} />
                    <ModelsSection merged={merged} metric={metric} />
                  </UsageUpdating>
                </>
              )}
            </>
          )}
        </Animated.View>
      </ScrollView>
    </SettingsScreen>
  );
}

/**
 * Dims totals that are about to change and says what is still updating. The
 * status overlays the first child's top-right corner, the chart card's label
 * row, so appearing never moves anything.
 */
function UsageUpdating({
  dimmed,
  label,
  children,
}: {
  readonly dimmed: boolean;
  readonly label: string | null;
  readonly children: ReactNode;
}) {
  const opacity = useSharedValue(1);
  useLayoutEffect(() => {
    // The delay keeps a quick cached answer from flashing the dim.
    opacity.set(
      dimmed
        ? withDelay(150, withTiming(0.5, { duration: 150, reduceMotion: ReduceMotion.System }))
        : withTiming(1, { duration: 150, reduceMotion: ReduceMotion.System }),
    );
  }, [opacity, dimmed]);
  const dimStyle = useAnimatedStyle(() => ({ opacity: opacity.get() }));

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
          <ActivityIndicator size="small" colorClassName="accent-adaptive-sky-600-400" />
          <Text className="shrink text-sm text-adaptive-sky-600-400" numberOfLines={1}>
            {label}
          </Text>
        </Animated.View>
      ) : null}
    </View>
  );
}

function CursorEnableAction({
  environmentId,
  label,
  onEnabled,
  buttonText = "Enable",
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly onEnabled: () => void;
  readonly buttonText?: string;
}) {
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "enable Cursor account usage",
  });
  const [pending, setPending] = useState(false);
  const enable = async () => {
    setPending(true);
    try {
      const result = await updateSettings({
        environmentId,
        input: { patch: { cursorKeychainUsageEnabled: true } },
      });
      if (result._tag === "Success") onEnabled();
    } finally {
      setPending(false);
    }
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Enable Cursor usage from ${label}`}
      accessibilityHint={CURSOR_KEYCHAIN_COPY}
      disabled={pending}
      onPress={() => void enable()}
      className="rounded-full bg-primary px-4 py-2"
    >
      <Text className="text-sm font-medium text-primary-foreground">{buttonText}</Text>
    </Pressable>
  );
}

function CursorEnableRow({
  environmentId,
  label,
  showEnvironment,
  bordered,
  onEnabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly showEnvironment: boolean;
  readonly bordered: boolean;
  readonly onEnabled: () => void;
}) {
  const colors = useProviderColors();
  return (
    <View
      className={cn(
        "flex-row items-center justify-between gap-3 p-4",
        bordered && "border-t border-border-subtle",
      )}
    >
      <View className="min-w-0 flex-1 flex-row items-center gap-2">
        <View className="size-2.5 rounded-full" style={{ backgroundColor: colors.cursor }} />
        <Text className="shrink text-lg text-foreground">
          Cursor{showEnvironment ? ` · ${label}` : ""}
        </Text>
      </View>
      <CursorEnableAction environmentId={environmentId} label={label} onEnabled={onEnabled} />
    </View>
  );
}

function CursorEnableLimits({
  environments,
  onEnabled,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly onEnabled: () => void;
}) {
  return (
    <View className="gap-3">
      <View className="flex-row items-center gap-2 px-1">
        <ProviderIcon provider="cursor" size={18} />
        <Text className="text-base font-t3-medium text-foreground">Cursor</Text>
      </View>
      <View className="items-start gap-3 rounded-[24px] border-continuous bg-grouped-card p-4">
        <Text className="text-xs text-foreground-muted">{CURSOR_KEYCHAIN_COPY}</Text>
        <View className="flex-row flex-wrap gap-2">
          {environments.map((environment) => (
            <CursorEnableAction
              key={environment.environmentId}
              environmentId={environment.environmentId}
              label={environment.label}
              buttonText={environments.length > 1 ? `Enable on ${environment.label}` : "Enable"}
              onEnabled={onEnabled}
            />
          ))}
        </View>
      </View>
    </View>
  );
}

/** Headline figure, the animated daily chart, and its legend, in one card. */
function ChartCard(props: {
  readonly merged: MergedUsage;
  readonly days: readonly string[];
  readonly daily: readonly DailyTotals[];
  readonly metric: UsageChartMetric;
  readonly sinceDay: string;
  readonly untilDay: string;
  readonly isPast24Hours: boolean;
  readonly timeZone: string;
}) {
  const { merged, metric } = props;
  const colors = useProviderColors();
  const hasActivity = props.daily.some((period) => period.totalTokens > 0);

  return (
    <View className="gap-4 rounded-[24px] border-continuous bg-grouped-card p-4">
      <View className="gap-0.5">
        <Text className="text-sm text-foreground-muted">
          {metric === "cost" ? "Raw token cost" : "Processed tokens"}
        </Text>
        <Text className="text-4xl font-t3-bold tabular-nums text-foreground">
          {metric === "cost" ? `${formatUsd(merged.costUsd)}*` : formatTokens(merged.totalTokens)}
        </Text>
        <Text className="text-sm text-foreground-muted">
          {metric === "cost"
            ? "* if billed at full API rate"
            : `Across ${formatCount(merged.sessions)} sessions`}
        </Text>
      </View>

      {hasActivity ? (
        <UsageDailyChart
          days={props.days}
          daily={props.daily}
          metric={metric}
          height={CHART_HEIGHT}
        />
      ) : (
        <View style={{ height: CHART_HEIGHT }} className="items-center justify-center">
          <Text className="text-base text-foreground-muted">No activity in this window.</Text>
        </View>
      )}

      <View className="flex-row items-center justify-between">
        <Text className="text-xs text-foreground-tertiary">
          {props.isPast24Hours
            ? formatHourShort(props.days[0] ?? "", props.timeZone)
            : formatDayShort(props.sinceDay)}
        </Text>
        <View className="flex-row items-center gap-4">
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
        <Text className="text-xs text-foreground-tertiary">
          {props.isPast24Hours
            ? formatHourShort(props.days[props.days.length - 1] ?? "", props.timeZone)
            : formatDayShort(props.untilDay)}
        </Text>
      </View>
    </View>
  );
}

function ProviderSection(props: {
  readonly merged: MergedUsage;
  readonly metric: UsageChartMetric;
  readonly cursorAccessEnvironments: readonly EnvironmentUsageStatus[];
  readonly showCursorEnvironment: boolean;
  readonly onCursorEnabled: () => void;
}) {
  const { merged, metric } = props;
  const colors = useProviderColors();
  if (merged.providers.length === 0 && props.cursorAccessEnvironments.length === 0) return null;

  // Ranked by whatever the toggle is showing, so the rows always descend.
  // .sort() on a copy, not .toSorted(): Hermes doesn't ship the ES2023 method.
  const ordered = [...merged.providers].sort((a, b) =>
    metric === "cost" ? b.costUsd - a.costUsd : b.totalTokens - a.totalTokens,
  );
  const rows: Array<
    | { readonly kind: "usage"; readonly provider: (typeof ordered)[number] }
    | { readonly kind: "enable"; readonly environment: EnvironmentUsageStatus }
  > = ordered.map((provider) => ({ kind: "usage", provider }));
  const cursorInsertAt =
    Math.max(
      ordered.findIndex((provider) => provider.provider === "codex"),
      ordered.findIndex((provider) => provider.provider === "claude"),
    ) + 1;
  rows.splice(
    cursorInsertAt,
    0,
    ...props.cursorAccessEnvironments.map((environment) => ({
      kind: "enable" as const,
      environment,
    })),
  );

  return (
    <SettingsSection title="Providers">
      {rows.map((row, index) => {
        if (row.kind === "enable") {
          return (
            <CursorEnableRow
              key={`enable:${row.environment.environmentId}`}
              environmentId={row.environment.environmentId}
              label={row.environment.label}
              showEnvironment={props.showCursorEnvironment}
              bordered={index > 0}
              onEnabled={props.onCursorEnabled}
            />
          );
        }
        const provider = row.provider;
        const share = metric === "cost" ? provider.costShare : provider.tokenShare;
        return (
          <View
            key={provider.provider}
            className={index === 0 ? "gap-2 p-4" : "gap-2 border-t border-border-subtle p-4"}
          >
            <View className="flex-row items-baseline justify-between gap-3">
              <View className="flex-row items-center gap-2">
                <View
                  className="size-2.5 rounded-full"
                  style={{ backgroundColor: colors[provider.provider] }}
                />
                <Text className="text-lg text-foreground">{PROVIDER_LABEL[provider.provider]}</Text>
              </View>
              <Text className="text-lg tabular-nums text-foreground">
                {metric === "cost"
                  ? formatUsd(provider.costUsd)
                  : formatTokens(provider.totalTokens)}
              </Text>
            </View>
            <View className="h-1 flex-row overflow-hidden rounded-full bg-subtle">
              <View
                className="h-full rounded-full"
                style={{ flex: share, backgroundColor: colors[provider.provider] }}
              />
              <View style={{ flex: 1 - share }} />
            </View>
            <Text className="text-sm text-foreground-muted">
              {metric === "cost"
                ? `${formatPercent(share)} of cost · ${formatTokens(provider.totalTokens)} tokens`
                : `${formatPercent(share)} of tokens · ${formatUsd(provider.costUsd)}`}
            </Text>
          </View>
        );
      })}
    </SettingsSection>
  );
}

function TotalsSection(props: { readonly merged: MergedUsage; readonly isPast24Hours: boolean }) {
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
          label="Processed tokens"
          value={formatTokens(merged.totalTokens)}
          detail={`${formatTokens(periodAverage)} per active ${props.isPast24Hours ? "hour" : "day"}`}
        />
        <MetricCell
          label="Cache savings"
          value={formatUsd(merged.costQuality.cacheSavingsUsd)}
          detail={
            merged.costUsd > 0
              ? `${(merged.costQuality.cacheSavingsUsd / merged.costUsd).toFixed(1)}x the raw cost`
              : "vs full input rates"
          }
        />
        <MetricCell
          label="Cached input"
          value={formatTokens(merged.cachedInputTokens)}
          detail={`${formatPercent(cachedShare)} of observed input`}
        />
        <MetricCell
          label="Uncached input"
          value={formatTokens(merged.uncachedInputTokens)}
          detail={`${formatTokens(merged.cacheCreationTokens)} cache writes`}
        />
        <MetricCell
          label="Output"
          value={formatTokens(merged.outputTokens)}
          detail={`incl. ${formatTokens(merged.reasoningTokens)} reasoning`}
        />
        <MetricCell
          label="Unpriced"
          value={formatPercent(merged.costQuality.unpricedShare)}
          detail="of records, excluded from cost"
        />
      </View>
    </SettingsSection>
  );
}

function CostSection(props: { readonly merged: MergedUsage }) {
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
      <ShareBar label="By type" segments={byType} />
      {speedCost.fast + speedCost.ultrafast > 0 ? (
        <View className="border-t border-border-subtle">
          <ShareBar
            label="By speed"
            segments={bySpeed}
            aside={`${formatUsd(speedCost.premium)} premium`}
          />
        </View>
      ) : null}
    </SettingsSection>
  );
}

/** One part-to-whole cost bar with its legend. Empty segments are left out. */
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
}) {
  return (
    <View className="w-1/2 gap-0.5 p-4">
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <Text className="text-xl font-t3-medium tabular-nums text-foreground">{props.value}</Text>
      <Text className="text-xs text-foreground-tertiary">{props.detail}</Text>
    </View>
  );
}

function ModelsSection(props: { readonly merged: MergedUsage; readonly metric: UsageChartMetric }) {
  const { merged, metric } = props;
  const colors = useProviderColors();
  if (merged.models.length === 0) return null;

  // Ranked like the provider rows. .sort() on a copy, not .toSorted(): Hermes
  // doesn't ship the ES2023 method.
  const ordered = [...merged.models].sort((a, b) =>
    metric === "cost"
      ? b.costUsd - a.costUsd || b.totalTokens - a.totalTokens
      : b.totalTokens - a.totalTokens || b.costUsd - a.costUsd,
  );

  return (
    <SettingsSection title="By model">
      {ordered.map((model, index) => (
        <View
          key={`${model.provider}:${model.model}`}
          className={
            index === 0
              ? "flex-row items-center gap-3 p-4"
              : "flex-row items-center gap-3 border-t border-border-subtle p-4"
          }
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
                    isModelCostUnknown(model) ? "no known rates" : formatUsd(model.costUsd)
                  }`
                : isModelCostUnknown(model)
                  ? `no known rates · ${formatTokens(model.totalTokens)} tokens`
                  : `${formatPercent(model.costShare)} of cost · ${formatTokens(model.totalTokens)} tokens`}
            </Text>
          </View>
          <Text className="text-base tabular-nums text-foreground">
            {metric === "tokens"
              ? formatTokens(model.totalTokens)
              : isModelCostUnknown(model)
                ? "Unpriced"
                : formatUsd(model.costUsd)}
          </Text>
        </View>
      ))}
    </SettingsSection>
  );
}

/**
 * Says plainly when the totals are incomplete: an environment still answering,
 * one that failed, or one whose transcripts another environment already
 * reported.
 */
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
  // The reason matters: a denied grant and a failed scan need different fixes.
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
