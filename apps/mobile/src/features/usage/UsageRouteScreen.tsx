import { EnvironmentId, USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import {
  isCompatibleUsageContractVersion,
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
  formatUsd,
  makeWindow,
} from "@t3tools/shared/usageFormat";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, RefreshControl, ScrollView, View } from "react-native";
import Animated, { Easing, FadeIn, LinearTransition, ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import { SettingsSection } from "../settings/components/SettingsSection";
import { UsageDailyChart } from "./UsageDailyChart";
import { toggleUsageEnvironment } from "./usageEnvironmentSelection";
import { useRefreshLimits } from "./UsageLimitsSection";
import { UsageLimitsSection } from "./UsageLimitsPooled";
import { ControlPillMenu } from "../../components/ControlPill";
import { SymbolView } from "../../components/AppSymbol";
import type { UsageChartMetric } from "./usageChartData";
import { PROVIDER_LABEL, useProviderColors } from "./usageProviders";

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

/**
 * Two tabs over one screen. Usage is the transcript-derived spend for a
 * period; Limits is the live subscription quota, which has no period. Both
 * pull to refresh, each refreshing its own data.
 */
export function UsageRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<UsageTab>("usage");
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
  const limits = useRefreshLimits(selectedEnvironmentIds);

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
  const hasLoadingEnvironments = selectedEnvironments.some(isUsageLoading);
  const filterAccessibilityLabel = hasLoadingEnvironments
    ? "Filter usage environments, some environments are loading"
    : "Filter usage environments";
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
        subtitle: usageEnvironmentStatus(environment),
        state:
          selectedEnvironmentIds === null || selectedEnvironmentIds.has(environment.environmentId)
            ? ("on" as const)
            : ("off" as const),
      })),
    ],
    [environments, selectedEnvironmentIds],
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
          accessibilityLabel={filterAccessibilityLabel}
          title="Environments"
          actions={environmentActions}
          onPressAction={({ nativeEvent }) => selectEnvironment(nativeEvent.event)}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={filterAccessibilityLabel}
            className={cn(
              "items-center justify-center rounded-full",
              Platform.OS === "ios" ? "size-[28px]" : "size-[44px]",
            )}
          >
            <SymbolView name={filterIcon} size={22} tintColorClassName="accent-icon" />
            {hasLoadingEnvironments ? (
              <View
                pointerEvents="none"
                className="absolute -right-[2px] -top-[2px] size-[9px] rounded-full bg-amber-500"
              />
            ) : null}
          </Pressable>
        </ControlPillMenu>
      ) : null,
    [
      showEnvironmentFilter,
      environmentActions,
      selectEnvironment,
      filterAccessibilityLabel,
      filterIcon,
      hasLoadingEnvironments,
    ],
  );

  useLayoutEffect(() => {
    if (Platform.OS === "ios") {
      navigation.setOptions({ headerRight: () => environmentFilter });
    }
  }, [navigation, environmentFilter]);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title="Usage"
            onBack={() => navigation.goBack()}
            trailing={environmentFilter}
          />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          <RefreshControl
            refreshing={showingLimits ? limits.refreshing : refreshingUsage}
            onRefresh={showingLimits ? () => void limits.refresh() : refreshWindow}
          />
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
            />
          ) : (
            <>
              {/* Period and metric together: neither applies to Limits, and
                both change every number below, so they share one bar. */}
              <View className="flex-row items-center gap-3">
                <SegmentedControl
                  options={WINDOW_OPTIONS}
                  selected={windowDays}
                  onSelect={selectWindow}
                  size="compact"
                  className="flex-1"
                />
                <SegmentedControl
                  options={METRIC_OPTIONS}
                  selected={metric}
                  onSelect={setMetric}
                  size="compact"
                  className="w-36"
                />
              </View>
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
              ) : (
                <>
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
                  <ProviderSection merged={merged} metric={metric} />
                  <TotalsSection merged={merged} isPast24Hours={isPast24Hours} />
                  <ModelsSection merged={merged} />
                </>
              )}
            </>
          )}
        </Animated.View>
      </ScrollView>
    </View>
  );
}

function SegmentedControl<Value extends number | string>(props: {
  readonly options: readonly {
    readonly value: Value;
    readonly label: string;
    readonly accessibilityLabel?: string;
  }[];
  readonly selected: Value;
  readonly onSelect: (value: Value) => void;
  /** The tab bar is full height; filters under it are shorter so it stays primary. */
  readonly size?: "default" | "compact";
  /** "tab" for the view switcher; filters stay plain buttons. */
  readonly role?: "tab" | "button";
  readonly className?: string;
}) {
  const compact = props.size === "compact";
  return (
    <View
      accessible={false}
      className={cn(
        "flex-row overflow-hidden rounded-full border-continuous bg-card",
        props.className,
      )}
    >
      <Animated.View
        pointerEvents="none"
        layout={LinearTransition.duration(200)
          .easing(Easing.out(Easing.cubic))
          .reduceMotion(ReduceMotion.System)}
        className="absolute bottom-0 top-0 rounded-full bg-subtle-strong"
        style={{
          width: `${100 / props.options.length}%`,
          start: `${
            (Math.max(
              0,
              props.options.findIndex((option) => option.value === props.selected),
            ) *
              100) /
            props.options.length
          }%`,
        }}
      />
      {props.options.map((option) => {
        const active = option.value === props.selected;
        return (
          <Pressable
            key={String(option.value)}
            accessibilityRole={Platform.OS === "ios" ? "button" : (props.role ?? "button")}
            accessibilityLabel={option.accessibilityLabel ?? option.label}
            accessibilityState={{ selected: active }}
            onPress={() => props.onSelect(option.value)}
            className={cn(
              "flex-1 items-center justify-center rounded-full",
              compact ? "h-9" : "h-11",
            )}
          >
            <Text
              className={cn(
                compact ? "text-xs" : "text-sm",
                active ? "font-t3-medium text-foreground" : "text-foreground-muted",
              )}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
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
    <View className="gap-4 rounded-[24px] border-continuous bg-card p-4">
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
}) {
  const { merged, metric } = props;
  const colors = useProviderColors();
  if (merged.providers.length === 0) return null;

  // Ranked by whatever the toggle is showing, so the rows always descend.
  // .sort() on a copy, not .toSorted(): Hermes doesn't ship the ES2023 method.
  const ordered = [...merged.providers].sort((a, b) =>
    metric === "cost" ? b.costUsd - a.costUsd : b.totalTokens - a.totalTokens,
  );

  return (
    <SettingsSection title="Providers" card>
      {ordered.map((provider, index) => {
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
    <SettingsSection title="Totals" card>
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

function ModelsSection(props: { readonly merged: MergedUsage }) {
  const { merged } = props;
  const colors = useProviderColors();
  if (merged.models.length === 0) return null;

  return (
    <SettingsSection title="By model" card>
      {merged.models.map((model, index) => (
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
              {formatPercent(model.costShare)} of cost · {formatTokens(model.totalTokens)} tokens
            </Text>
          </View>
          <Text className="text-base tabular-nums text-foreground">{formatUsd(model.costUsd)}</Text>
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
function isUsageLoading(environment: EnvironmentUsageStatus) {
  return environment.isPending || (environment.summary === null && environment.error === null);
}

function usageEnvironmentStatus(environment: EnvironmentUsageStatus): string {
  if (
    environment.summary &&
    !isCompatibleUsageContractVersion(environment.summary.contractVersion, USAGE_CONTRACT_VERSION)
  ) {
    return "Older server · excluded from usage totals";
  }
  if (!environment.isConnected)
    return environment.summary ? "Disconnected · showing saved usage" : "Waiting for connection…";
  if (environment.error)
    return environment.summary ? "Usage unavailable · showing saved totals" : "Usage unavailable";
  if (isUsageLoading(environment))
    return environment.summary ? "Updating usage…" : "Loading usage…";
  return "Usage up to date";
}
