import { Button } from "../../components/ui/Button";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { ChatGptUsageSummary } from "./ChatGptUsageSummary";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { EnvironmentId, USAGE_CONTRACT_VERSION, type UsageProviderKind } from "@t3tools/contracts";
import { type RouteProp, useIsFocused, useRoute } from "@react-navigation/native";
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
  usageSourceMessages,
} from "@t3tools/shared/usageFormat";
import { useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, RefreshControl, View } from "react-native";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useReduceMotionEnabled } from "../../lib/appState";
import { AppText as Text } from "../../components/ui/AppText";
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
import { Menu } from "../../components/ui/Menu";
import { SymbolView } from "../../components/ui/AppSymbol";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import type { UsageChartMetric } from "./usageChartData";
import { PROVIDER_LABEL, useProviderColors, useUsageMixColors } from "./usageProviders";
import type { UsageView } from "./UsageRouteScreen";
import { CHART_HEIGHT, ChartCard, CostSection, CursorEnableLimits, MAX_CONTENT_WIDTH, ModelsSection, ProviderSection, TotalsSection, UsageSummary, UsageUpdating, VIEW_OPTIONS, WIDE_CHART_HEIGHT, WIDE_WIDTH, WINDOW_OPTIONS, providerLabel, usageEnvironmentStatus } from "./UsageRouteScreen";

export function UsageScreen(props: {
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
  const [width, setWidth] = useState(0);
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
  );
  const isFocused = useIsFocused();
  const limits = useRefreshLimits(selectedEnvironmentIds, isFocused && view === "limits");
  const cursorAccessEnvironments = cursorKeychainAccessEnvironments(selectedEnvironments);
  const refreshAfterCursorEnable = () => {
    void refresh();
    void limits.refreshAfterEnable();
  };
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
  const providers = (
    <ProviderSection
      merged={merged}
      metric={metric}
      cursorAccessEnvironments={cursorAccessEnvironments}
      showCursorEnvironment={selectedEnvironments.length > 1}
      onCursorEnabled={refreshAfterCursorEnable}
      compact={wide}
    />
  );

  const showEnvironmentFilter = environments.length > 0 || selectedEnvironmentIds !== null;
  const filterIcon =
    selectedEnvironmentIds === null
      ? "line.3.horizontal.decrease"
      : "line.3.horizontal.decrease.circle.fill";
  const environmentActions = [
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
  ];
  const selectEnvironment = (value: string) => {
    if (value === "all") {
      setSelectedEnvironmentIds(null);
      return;
    }
    const id = EnvironmentId.make(value);
    setSelectedEnvironmentIds((selected) => toggleUsageEnvironment(selected, environments, id));
  };
  const environmentFilter = showEnvironmentFilter ? (
    <Menu
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
    </Menu>
  ) : null;

  return (
    <SettingsScreen title="Usage" trailing={environmentFilter} workspaceRoot={props.workspace}>
      {Platform.OS === "ios" ? (
        <NativeStackScreenOptions
          optionsVersion={JSON.stringify({ showEnvironmentFilter, filterIcon, environmentActions })}
          options={{
            // A native menu item, unlike a custom view, moves into the Duo's vertical bar.
            unstable_headerRightItems: () =>
              showEnvironmentFilter
                ? [
                    withNativeGlassHeaderItem({
                      accessibilityLabel: "Filter usage environments",
                      icon: { name: filterIcon, type: "sfSymbol" },
                      label: "",
                      type: "menu",
                      menu: {
                        title: "Environments",
                        items: environmentActions.map((action) => ({
                          type: "action" as const,
                          label: action.title,
                          description: action.subtitle,
                          state: action.state === "on" ? ("on" as const) : undefined,
                          onPress: () => selectEnvironment(action.id),
                        })),
                      },
                    }),
                  ]
                : [],
          }}
        />
      ) : null}
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
                {wide ? null : (
                  <SegmentedControl
                    options={WINDOW_OPTIONS}
                    selected={windowDays}
                    onSelect={selectWindow}
                    size="compact"
                  />
                )}
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

