import { translate } from "@t3tools/i18n";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useTranslation } from "@t3tools/i18n/react";
import { EnvironmentId, USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { type RouteProp, useIsFocused, useNavigation, useRoute } from "@react-navigation/native";
import { cursorKeychainAccessEnvironments } from "@t3tools/client-runtime/state/usage";
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
  formatUsd,
  makeWindow,
} from "@t3tools/shared/usageFormat";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, RefreshControl, View } from "react-native";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
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
import { PROVIDER_LABEL, useProviderColors } from "./usageProviders";

type UsageTab = "usage" | "limits";
// Labels are abbreviated to share a row with the metric toggle; screen
// readers get the full phrase.
const WINDOW_DAYS = [1, 7, 30, 90] as const;

const CHART_HEIGHT = 180;
const cursorKeychainCopy = () =>
  translate(
    "common:mobileUsage.cursorKeychain",
    "Requires access to your Cursor login in macOS Keychain.",
  );

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
  const tabOptions = [
    { value: "usage", label: translate("common:mobileUsage.usageTab", "Usage") },
    { value: "limits", label: translate("common:mobileUsage.limitsTab", "Limits") },
  ] as const satisfies readonly { value: UsageTab; label: string }[];
  const windowOptions = WINDOW_DAYS.map((days) => ({
    value: days,
    label: `${days}${days === 1 ? "h" : "d"}`,
    accessibilityLabel: translate(
      days === 1 ? "common:mobileUsage.pastHours" : "common:mobileUsage.pastDays",
      days === 1 ? "Past {{count}} hours" : "Past {{count}} days",
      { count: days === 1 ? 24 : days },
    ),
  }));
  const metricOptions = [
    { value: "cost", label: translate("common:mobileUsage.cost", "Cost") },
    { value: "tokens", label: translate("common:mobileUsage.tokens", "Tokens") },
  ] as const satisfies readonly { value: UsageChartMetric; label: string }[];
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
    ? translate(
        "common:mobileUsage.filterLoading",
        "Filter usage environments, some environments are loading",
      )
    : translate("common:mobileUsage.filter", "Filter usage environments");
  const filterIcon =
    selectedEnvironmentIds === null
      ? "line.3.horizontal.decrease"
      : "line.3.horizontal.decrease.circle.fill";
  const environmentActions = useMemo(
    () => [
      {
        id: "all",
        title: translate("common:mobileUsage.allEnvironments", "All environments"),
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
          title={translate("common:environments", "Environments")}
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
    <SettingsScreen title={translate("common:usage", "Usage")} trailing={environmentFilter}>
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
        <SegmentedControl options={tabOptions} selected={tab} onSelect={setTab} role="tab" />
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
                  options={windowOptions}
                  selected={windowDays}
                  onSelect={selectWindow}
                  size="compact"
                  className="w-full ios:flex-1"
                />
                <SegmentedControl
                  options={metricOptions}
                  selected={metric}
                  onSelect={setMetric}
                  size="compact"
                  className="w-full ios:w-36"
                />
              </View>
              {merged.duplicateSources.length > 0 ? (
                <Text className="text-sm text-foreground-muted">
                  {translate(
                    "common:mobileUsage.duplicateSources",
                    "Counted once across environments sharing a transcript directory: {{sources}}",
                    { sources: merged.duplicateSources.join(", ") },
                  )}
                </Text>
              ) : null}
              {isPending ? (
                <Text className="py-16 text-center text-base text-foreground-muted">
                  {translate(
                    "common:mobileScanningProviderTranscripts",
                    "Scanning provider transcripts…",
                  )}
                </Text>
              ) : selectedEnvironments.length === 0 ? (
                <Text className="py-16 text-center text-base text-foreground-muted">
                  {environments.length === 0
                    ? translate(
                        "common:mobileUsage.noEnvironment",
                        "Connect an environment to see usage.",
                      )
                    : translate(
                        "common:mobileUsage.chooseEnvironment",
                        "Select an environment to see usage.",
                      )}
                </Text>
              ) : (
                <>
                  {sourceMessages.map((message) => (
                    <Text key={message} className="text-sm text-foreground-muted">
                      {message}
                    </Text>
                  ))}
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
                  <ModelsSection merged={merged} />
                </>
              )}
            </>
          )}
        </Animated.View>
      </ScrollView>
    </SettingsScreen>
  );
}

function CursorEnableAction({
  environmentId,
  label,
  onEnabled,
  buttonText = translate("common:mobileUsage.enable", "Enable"),
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
      accessibilityLabel={translate(
        "common:mobileUsage.enableCursorFrom",
        "Enable Cursor usage from {{environment}}",
        { environment: label },
      )}
      accessibilityHint={cursorKeychainCopy()}
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
      <View className="items-start gap-3 rounded-[24px] border-continuous bg-card p-4">
        <Text className="text-xs text-foreground-muted">{cursorKeychainCopy()}</Text>
        <View className="flex-row flex-wrap gap-2">
          {environments.map((environment) => (
            <CursorEnableAction
              key={environment.environmentId}
              environmentId={environment.environmentId}
              label={environment.label}
              buttonText={
                environments.length > 1
                  ? translate("common:mobileUsage.enableOn", "Enable on {{environment}}", {
                      environment: environment.label,
                    })
                  : translate("common:mobileUsage.enable", "Enable")
              }
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
  const { t } = useTranslation();
  const { merged, metric } = props;
  const colors = useProviderColors();
  const hasActivity = props.daily.some((period) => period.totalTokens > 0);

  return (
    <View className="gap-4 rounded-[24px] border-continuous bg-card p-4">
      <View className="gap-0.5">
        <Text className="text-sm text-foreground-muted">
          {metric === "cost"
            ? translate("common:mobileUsage.rawTokenCost", "Raw token cost")
            : translate("common:mobileUsage.processedTokens", "Processed tokens")}
        </Text>
        <Text className="text-4xl font-t3-bold tabular-nums text-foreground">
          {metric === "cost" ? `${formatUsd(merged.costUsd)}*` : formatTokens(merged.totalTokens)}
        </Text>
        <Text className="text-sm text-foreground-muted">
          {metric === "cost"
            ? translate("common:mobileUsage.billedAtFullApiRate", "* if billed at full API rate")
            : translate("common:mobileUsage.acrossSessions", "Across {{count}} sessions", {
                count: formatCount(merged.sessions),
              })}
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
          <Text className="text-base text-foreground-muted">{t("noActivityInWindow")}</Text>
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
    <SettingsSection title={translate("common:providers", "Providers")}>
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
                ? translate(
                    "common:mobileUsage.ofCostTokens",
                    "{{percent}} of cost · {{tokens}} tokens",
                    { percent: formatPercent(share), tokens: formatTokens(provider.totalTokens) },
                  )
                : translate("common:mobileUsage.ofTokensCost", "{{percent}} of tokens · {{cost}}", {
                    percent: formatPercent(share),
                    cost: formatUsd(provider.costUsd),
                  })}
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
    <SettingsSection title={translate("usage:totals", "Totals")}>
      <View className="flex-row flex-wrap">
        <MetricCell
          label={translate("usage:processedTokens", "Processed tokens")}
          value={formatTokens(merged.totalTokens)}
          detail={translate(
            "common:mobileUsage.perActivePeriod",
            "{{count}} per active {{period}}",
            {
              count: formatTokens(periodAverage),
              period: translate(
                props.isPast24Hours ? "common:mobileUsage.hour" : "common:mobileUsage.day",
                props.isPast24Hours ? "hour" : "day",
              ),
            },
          )}
        />
        <MetricCell
          label={translate("usage:cacheSavings", "Cache savings")}
          value={formatUsd(merged.costQuality.cacheSavingsUsd)}
          detail={
            merged.costUsd > 0
              ? translate("common:mobileUsage.timesRawCost", "{{count}}x the raw cost", {
                  count: (merged.costQuality.cacheSavingsUsd / merged.costUsd).toFixed(1),
                })
              : translate("common:mobileUsage.vsFullInputRates", "vs full input rates")
          }
        />
        <MetricCell
          label={translate("usage:cachedInput", "Cached input")}
          value={formatTokens(merged.cachedInputTokens)}
          detail={translate("common:mobileUsage.ofObservedInput", "{{count}} of observed input", {
            count: formatPercent(cachedShare),
          })}
        />
        <MetricCell
          label={translate("usage:uncachedInput", "Uncached input")}
          value={formatTokens(merged.uncachedInputTokens)}
          detail={translate("common:mobileUsage.cacheWrites", "{{count}} cache writes", {
            count: formatTokens(merged.cacheCreationTokens),
          })}
        />
        <MetricCell
          label={translate("usage:output", "Output")}
          value={formatTokens(merged.outputTokens)}
          detail={translate("common:mobileUsage.includingReasoning", "incl. {{count}} reasoning", {
            count: formatTokens(merged.reasoningTokens),
          })}
        />
        <MetricCell
          label={translate("usage:unpriced", "Unpriced")}
          value={formatPercent(merged.costQuality.unpricedShare)}
          detail={translate(
            "common:mobileUsage.recordsExcludedFromCost",
            "of records, excluded from cost",
          )}
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
    <SettingsSection title={translate("common:mobileByModel", "By model")}>
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
              {isModelCostUnknown(model)
                ? translate(
                    "common:mobileUsage.noKnownRates",
                    "no known rates · {{count}} tokens",
                    { count: formatTokens(model.totalTokens) },
                  )
                : translate(
                    "common:mobileUsage.ofCostTokens",
                    "{{percent}} of cost · {{tokens}} tokens",
                    {
                      percent: formatPercent(model.costShare),
                      tokens: formatTokens(model.totalTokens),
                    },
                  )}
            </Text>
          </View>
          <Text className="text-base tabular-nums text-foreground">
            {isModelCostUnknown(model)
              ? translate("usage:unpriced", "Unpriced")
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
function isUsageLoading(environment: EnvironmentUsageStatus) {
  return environment.isPending || (environment.summary === null && environment.error === null);
}

function usageEnvironmentStatus(environment: EnvironmentUsageStatus): string {
  if (
    environment.summary &&
    !isCompatibleUsageContractVersion(environment.summary.contractVersion, USAGE_CONTRACT_VERSION)
  ) {
    return environment.summary.contractVersion < USAGE_CONTRACT_VERSION
      ? translate(
          "common:mobileUsage.serverBehind",
          "{{environment}} runs an older server version and is excluded from totals.",
          { environment: environment.label },
        )
      : translate(
          "common:mobileUsage.clientBehind",
          "This client is older than the server on {{environment}}; its usage is excluded from totals.",
          { environment: environment.label },
        );
  }
  if (!environment.isConnected)
    return environment.summary
      ? translate("common:mobileUsage.disconnectedSavedUsage", "Disconnected · showing saved usage")
      : translate("common:mobileUsage.waitingForConnection", "Waiting for connection…");
  if (environment.error)
    return environment.summary
      ? translate(
          "common:mobileUsage.usageUnavailableSaved",
          "Usage unavailable · showing saved totals",
        )
      : translate("common:mobileUsage.usageUnavailable", "Usage unavailable");
  if (isUsageLoading(environment))
    return environment.summary
      ? translate("common:mobileUsage.updatingUsage", "Updating usage…")
      : translate("common:mobileUsage.loadingUsage", "Loading usage…");
  return translate("common:mobileUsage.upToDate", "Usage up to date");
}
