import { useIsFocused, useNavigation } from "@react-navigation/native";
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
import type { DailyTotals, MergedUsage } from "@t3tools/shared/usageMerge";
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
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useSubscriptionAllowance } from "../../state/subscriptionAllowance";
import { useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import { SettingsSection } from "../settings/components/SettingsSection";
import { UsageDailyChart } from "./UsageDailyChart";
import type { UsageChartMetric } from "./usageChartData";
import { PROVIDER_LABEL, useProviderColors } from "./usageProviders";

const WINDOW_OPTIONS = [
  { days: 1, label: "Past 24h" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

const CHART_HEIGHT = 180;

function useNowMinuteMs(): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(intervalId);
  }, []);

  return nowMs;
}

type HistoricalWindowSelection = {
  readonly days: number;
  readonly window: ReturnType<typeof makeWindow>;
};

export function UsageRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const [view, setView] = useState<UsageView>(DEFAULT_USAGE_VIEW);
  const [windowSelection, setWindowSelection] = useState(() => ({
    days: 30,
    window: makeWindow(30),
  }));
  const [metric, setMetric] = useState<UsageChartMetric>("cost");

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Usage" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <UsageContent
        view={view}
        isFocused={isFocused}
        onViewChange={setView}
        insetsBottom={insets.bottom}
        windowSelection={windowSelection}
        onWindowSelectionChange={setWindowSelection}
        metric={metric}
        onMetricChange={setMetric}
      />
    </View>
  );
}

function UsageContent(props: {
  readonly view: UsageView;
  readonly isFocused: boolean;
  readonly onViewChange: (view: UsageView) => void;
  readonly insetsBottom: number;
  readonly windowSelection: HistoricalWindowSelection;
  readonly onWindowSelectionChange: (selection: HistoricalWindowSelection) => void;
  readonly metric: UsageChartMetric;
  readonly onMetricChange: (metric: UsageChartMetric) => void;
}) {
  // Mount only the selected data source so leaving Subscription tears down its
  // allowance stream and leaving Historical releases its transcript query.
  if (!props.isFocused) return null;

  return props.view === "subscription" ? (
    <SubscriptionUsageContent onViewChange={props.onViewChange} insetsBottom={props.insetsBottom} />
  ) : (
    <HistoricalUsageContent
      onViewChange={props.onViewChange}
      insetsBottom={props.insetsBottom}
      windowSelection={props.windowSelection}
      onWindowSelectionChange={props.onWindowSelectionChange}
      metric={props.metric}
      onMetricChange={props.onMetricChange}
    />
  );
}

function HistoricalUsageContent(props: {
  readonly onViewChange: (view: UsageView) => void;
  readonly insetsBottom: number;
  readonly windowSelection: HistoricalWindowSelection;
  readonly onWindowSelectionChange: (selection: HistoricalWindowSelection) => void;
  readonly metric: UsageChartMetric;
  readonly onMetricChange: (metric: UsageChartMetric) => void;
}) {
  const { days: windowDays, window } = props.windowSelection;
  const isPast24Hours = windowDays === 1;
  const { merged, environments, isPending, isPartial, refresh } = useUsage(window);

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

  // The pull spinner tracks re-scans of environments that have answered
  // before. The initial scan renders its own placeholder, and an unreachable
  // environment stays pending forever — neither may pin the spinner on.
  const refreshing = environments.some((entry) => entry.isPending && entry.summary !== null);
  const selectWindow = (days: number) => {
    props.onWindowSelectionChange({
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
      props.onWindowSelectionChange({ days: windowDays, window: nextWindow });
    }
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      className="flex-1"
      contentContainerClassName="gap-6 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(props.insetsBottom, 18) + 18 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refreshWindow} />}
    >
      <UsageViewTabs value="historical" onChange={props.onViewChange} />
      <SegmentedControl
        accessibilityLabel="Historical usage window"
        options={WINDOW_OPTIONS.map((option) => ({ value: option.days, label: option.label }))}
        selected={windowDays}
        onSelect={selectWindow}
      />

      <UsageCoverageNotice environments={environments} merged={merged} isPartial={isPartial} />

      {isPending ? (
        <Text className="py-16 text-center text-base text-foreground-muted">
          Scanning provider transcripts…
        </Text>
      ) : environments.length === 0 ? (
        <Text className="py-16 text-center text-base text-foreground-muted">
          Connect an environment to see usage.
        </Text>
      ) : (
        <>
          <ChartCard
            merged={merged}
            days={chartDays}
            daily={chartTotals}
            metric={props.metric}
            onMetricChange={props.onMetricChange}
            sinceDay={window.sinceDay}
            untilDay={window.untilDay}
            isPast24Hours={isPast24Hours}
            timeZone={window.timeZone}
          />
          <ProviderSection merged={merged} metric={props.metric} />
          <TotalsSection merged={merged} isPast24Hours={isPast24Hours} />
          <ModelsSection merged={merged} />
        </>
      )}
    </ScrollView>
  );
}

function UsageViewTabs(props: {
  readonly value: UsageView;
  readonly onChange: (view: UsageView) => void;
}) {
  return (
    <SegmentedControl
      accessibilityLabel="Usage view"
      options={USAGE_VIEW_OPTIONS}
      selected={props.value}
      onSelect={props.onChange}
    />
  );
}

function SubscriptionUsageContent(props: {
  readonly onViewChange: (view: UsageView) => void;
  readonly insetsBottom: number;
}) {
  const { groups, environments, isPending, isPartial, isRefreshing, refresh } =
    useSubscriptionAllowance();
  const nowMs = useNowMinuteMs();
  const environmentNotices = environments.flatMap((environment) => {
    const message = formatAllowanceEnvironmentNotice(environment);
    return message === null ? [] : [{ environmentId: environment.environmentId, message }];
  });
  // Keep already available cards visible while another environment answers.
  // Only an empty first response needs the full loading placeholder.
  const phase = subscriptionViewPhase({
    isPending,
    isPartial,
    groupCount: groups.length,
  });

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      className="flex-1"
      contentContainerClassName="gap-6 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(props.insetsBottom, 18) + 18 }}
      refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={refresh} />}
    >
      <UsageViewTabs value="subscription" onChange={props.onViewChange} />

      <View className="gap-0.5">
        <View>
          <Text accessibilityRole="header" className="text-lg font-t3-medium text-foreground">
            Subscription allowance
          </Text>
          <Text className="text-sm text-foreground-muted">
            Usage limits and reset times from your provider.
          </Text>
        </View>
      </View>

      {phase === "loading" ? (
        <View className="items-center gap-3 rounded-[24px] border-continuous bg-card px-4 py-10">
          <ActivityIndicator />
          <Text className="text-sm text-foreground-muted">Reading provider allowance…</Text>
        </View>
      ) : groups.length === 0 ? (
        <View className="gap-1 rounded-[24px] border-continuous bg-card px-4 py-6">
          {environmentNotices.length > 0 ? (
            environmentNotices.map((notice) => (
              <Text key={notice.environmentId} className="text-sm text-foreground-muted">
                {notice.message}
              </Text>
            ))
          ) : environments.length === 0 ? (
            <Text className="text-sm text-foreground-muted">
              Connect an environment to see subscription allowance data.
            </Text>
          ) : (
            <Text className="text-sm text-foreground-muted">
              No enabled provider reports subscription allowance data.
            </Text>
          )}
        </View>
      ) : (
        <>
          {environmentNotices.length > 0 ? (
            <View className="gap-1 rounded-[16px] border-continuous bg-card px-4 py-3">
              {environmentNotices.map((notice) => (
                <Text key={notice.environmentId} className="text-xs text-foreground-muted">
                  {notice.message}
                </Text>
              ))}
            </View>
          ) : null}
          {phase === "partial" ? (
            <Text className="text-xs text-foreground-muted">
              Some environments are still reporting.
            </Text>
          ) : null}
          <View className="gap-4">
            {groups.map((group) => (
              <SubscriptionAllowanceCard
                key={group.key}
                model={presentSubscriptionAllowanceGroup(group)}
                nowMs={nowMs}
              />
            ))}
          </View>
        </>
      )}
    </ScrollView>
  );
}

function SubscriptionAllowanceCard(props: {
  readonly model: SubscriptionAllowanceCardModel;
  readonly nowMs: number;
}) {
  const { model } = props;
  const updatedAt = formatAllowanceUpdatedAt(model.updatedAt, props.nowMs);
  const providerColors = useProviderColors();

  return (
    <View className="gap-5 rounded-[24px] border-continuous bg-card p-4">
      <View className="gap-1">
        <View className="flex-row items-baseline gap-2">
          <Text accessibilityRole="header" className="text-lg font-t3-medium text-foreground">
            {PROVIDER_LABEL[model.provider]}
          </Text>
          {model.accountLabel !== null ? (
            <Text className="min-w-0 flex-1 text-sm text-foreground-muted" numberOfLines={1}>
              {model.accountLabel}
            </Text>
          ) : null}
        </View>
        <View className="flex-row items-baseline justify-end gap-2">
          <Text
            className={
              model.isStale
                ? "text-xs font-t3-medium text-amber-600"
                : "text-xs text-foreground-muted"
            }
          >
            {model.isStale
              ? updatedAt === null
                ? "Stale"
                : `Stale · ${updatedAt}`
              : (updatedAt ?? "Updated time unavailable")}
          </Text>
        </View>
      </View>

      {model.status === "unavailable" ? (
        <Text className="text-sm text-foreground-muted">{model.message}</Text>
      ) : (
        <>
          <View className="gap-4">
            {model.windows.map((window) => (
              <AllowanceWindowRow
                key={window.scope}
                window={window}
                progressColor={providerColors[model.provider]}
              />
            ))}
          </View>
          <AllowanceMetadata model={model} />
        </>
      )}

      {model.hasMultipleReadings ? (
        <Text className="border-t border-border-subtle pt-3 text-xs text-foreground-muted">
          Multiple readings are available; showing one whole provider source.
        </Text>
      ) : null}
      {model.sources.length > 1 ? <AllowanceSources sources={model.sources} /> : null}
    </View>
  );
}

function AllowanceWindowRow(props: {
  readonly window: SubscriptionAllowanceCardModel["windows"][number];
  readonly progressColor: string;
}) {
  const { window, progressColor } = props;
  const hasUsage = window.usedPercent !== undefined && window.usedPercent !== null;
  const duration = formatAllowanceDuration(window.windowDurationMins);
  const reset =
    window.resetsAt === undefined || window.resetsAt === null
      ? null
      : formatAllowanceResetAt(window.resetsAt);

  return (
    <View className="gap-1.5">
      <View className="flex-row items-baseline justify-between gap-3">
        <Text className="min-w-0 flex-1 text-sm text-foreground">
          {formatAllowanceWindowScope(window.scope)}
        </Text>
        <Text className="text-sm tabular-nums text-foreground">
          {hasUsage ? `${window.usedPercent}% used` : "Not reported"}
        </Text>
      </View>
      {hasUsage ? (
        <View className="h-1.5 flex-row overflow-hidden rounded-full bg-subtle">
          <View
            className="h-full rounded-full"
            style={{
              width: `${progressWidthForAllowance(window.usedPercent)}%`,
              backgroundColor: progressColor,
            }}
          />
        </View>
      ) : null}
      {duration !== null || reset !== null ? (
        <Text className="text-xs text-foreground-muted">
          {[duration, reset === null ? null : `Resets ${reset}`].filter(Boolean).join(" · ")}
        </Text>
      ) : null}
    </View>
  );
}

function AllowanceMetadata(props: { readonly model: SubscriptionAllowanceCardModel }) {
  const { model } = props;
  const credits = model.credits;
  const spendingControl = model.spendingControl;
  const extraUsage = model.extraUsage;
  const spendingControlReset =
    spendingControl?.resetsAt === undefined || spendingControl.resetsAt === null
      ? null
      : formatAllowanceResetAt(spendingControl.resetsAt);

  return (
    <>
      {credits !== null ? (
        <View className="flex-row flex-wrap gap-x-4 gap-y-1 border-t border-border-subtle pt-3">
          <Text className="text-xs text-foreground-muted">Credits</Text>
          {credits.balance !== undefined && credits.balance !== null ? (
            <Text className="text-xs text-foreground-muted">Balance {credits.balance}</Text>
          ) : null}
          <Text className="text-xs text-foreground-muted">
            {credits.unlimited ? "Unlimited" : credits.hasCredits ? "Available" : "No credits"}
          </Text>
        </View>
      ) : null}

      {spendingControl !== null && shouldShowSpendingControl(spendingControl) ? (
        <View className="flex-row flex-wrap gap-x-4 gap-y-1 border-t border-border-subtle pt-3">
          <Text className="text-xs text-foreground-muted">Spending control</Text>
          {spendingControl.limit !== undefined && spendingControl.limit !== null ? (
            <Text className="text-xs text-foreground-muted">Limit {spendingControl.limit}</Text>
          ) : null}
          {spendingControl.used !== undefined && spendingControl.used !== null ? (
            <Text className="text-xs text-foreground-muted">Used {spendingControl.used}</Text>
          ) : null}
          {spendingControl.remainingPercent !== undefined &&
          spendingControl.remainingPercent !== null ? (
            <Text className="text-xs text-foreground-muted">
              {spendingControl.remainingPercent}% remaining
            </Text>
          ) : null}
          {spendingControlReset !== null ? (
            <Text className="text-xs text-foreground-muted">Resets {spendingControlReset}</Text>
          ) : null}
          {spendingControl.reached === true ? (
            <Text className="text-xs text-foreground-muted">Limit reached</Text>
          ) : null}
        </View>
      ) : null}

      {extraUsage !== null && shouldShowExtraUsage(extraUsage) ? (
        <View className="flex-row flex-wrap gap-x-4 gap-y-1 border-t border-border-subtle pt-3">
          <Text className="text-xs text-foreground-muted">Extra usage</Text>
          <Text className="text-xs text-foreground-muted">
            {extraUsage.isEnabled ? "Enabled" : "Disabled"}
          </Text>
          {extraUsage.monthlyLimit !== null ? (
            <Text className="text-xs text-foreground-muted">
              Monthly limit {extraUsage.monthlyLimit}
            </Text>
          ) : null}
          {extraUsage.usedCredits !== null ? (
            <Text className="text-xs text-foreground-muted">
              Used credits {extraUsage.usedCredits}
            </Text>
          ) : null}
          {extraUsage.utilization !== null ? (
            <Text className="text-xs text-foreground-muted">{extraUsage.utilization}% used</Text>
          ) : null}
          {extraUsage.currency !== undefined && extraUsage.currency !== null ? (
            <Text className="text-xs text-foreground-muted">{extraUsage.currency}</Text>
          ) : null}
        </View>
      ) : null}
    </>
  );
}

function AllowanceSources(props: {
  readonly sources: readonly SubscriptionAllowanceCardModel["sources"][number][];
}) {
  return (
    <View className="gap-1 border-t border-border-subtle pt-3">
      <Text className="text-xs text-foreground-muted">Sources</Text>
      {props.sources.map((source) => (
        <Text key={source.key} className="text-xs text-foreground-muted">
          {source.environmentLabel} · {source.instanceId} · {source.connectionLabel} ·{" "}
          {source.status}
          {source.isStale ? " · stale" : ""}
          {source.isEffective ? " · shown" : ""}
        </Text>
      ))}
    </View>
  );
}

function SegmentedControl<Value extends number | string>(props: {
  readonly accessibilityLabel?: string;
  readonly options: readonly { readonly value: Value; readonly label: string }[];
  readonly selected: Value;
  readonly onSelect: (value: Value) => void;
}) {
  return (
    <View
      accessibilityLabel={props.accessibilityLabel}
      className="flex-row overflow-hidden rounded-full border-continuous bg-card"
    >
      {props.options.map((option) => {
        const active = option.value === props.selected;
        return (
          <Pressable
            key={String(option.value)}
            accessibilityLabel={option.label}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => props.onSelect(option.value)}
            className={
              active
                ? "flex-1 items-center rounded-full bg-subtle-strong py-2"
                : "flex-1 items-center py-2"
            }
          >
            <Text
              className={
                active ? "text-sm font-t3-medium text-foreground" : "text-sm text-foreground-muted"
              }
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
  readonly onMetricChange: (metric: UsageChartMetric) => void;
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
      <View className="flex-row items-start justify-between gap-3">
        <View className="min-w-0 flex-1 gap-0.5">
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
        <MetricToggle metric={metric} onChange={props.onMetricChange} />
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

function MetricToggle(props: {
  readonly metric: UsageChartMetric;
  readonly onChange: (metric: UsageChartMetric) => void;
}) {
  return (
    <View className="flex-row overflow-hidden rounded-full bg-subtle">
      {(["cost", "tokens"] as const).map((option) => {
        const active = option === props.metric;
        return (
          <Pressable
            key={option}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => props.onChange(option)}
            className={active ? "rounded-full bg-subtle-strong px-3 py-1.5" : "px-3 py-1.5"}
          >
            <Text
              className={
                active
                  ? "text-xs font-t3-medium uppercase text-foreground"
                  : "text-xs uppercase text-foreground-muted"
              }
            >
              {option}
            </Text>
          </Pressable>
        );
      })}
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
function UsageCoverageNotice(props: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly merged: MergedUsage;
  readonly isPartial: boolean;
}) {
  const failed = props.environments.filter((environment) => environment.error !== null);
  const stale = props.environments.filter((environment) =>
    props.merged.staleEnvironments.includes(environment.environmentId),
  );
  const duplicateSources = props.merged.duplicateSources;
  if (
    failed.length === 0 &&
    stale.length === 0 &&
    duplicateSources.length === 0 &&
    !props.isPartial
  ) {
    return null;
  }

  return (
    <View className="gap-1 rounded-[16px] border-continuous bg-card px-4 py-3">
      {props.isPartial ? (
        <Text className="text-sm text-foreground-muted">
          Some environments are still reporting. Totals are partial.
        </Text>
      ) : null}
      {failed.map((environment) => (
        <Text key={environment.environmentId} className="text-sm text-foreground-muted">
          {environment.label} could not report usage.
        </Text>
      ))}
      {stale.map((environment) => (
        <Text key={environment.environmentId} className="text-sm text-foreground-muted">
          {environment.label} runs an older server version and is excluded from totals.
        </Text>
      ))}
      {duplicateSources.length > 0 ? (
        <Text className="text-sm text-foreground-muted">
          Counted once across environments sharing a transcript directory:{" "}
          {duplicateSources.join(", ")}
        </Text>
      ) : null}
    </View>
  );
}
