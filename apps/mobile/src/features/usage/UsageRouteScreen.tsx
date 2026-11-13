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
import { UsageScreen } from "./UsageRouteScreenParts";

export type UsageView = UsageChartMetric | "limits";
export const VIEW_OPTIONS = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
  { value: "limits", label: "Limits" },
] as const satisfies readonly { value: UsageView; label: string }[];

export const WINDOW_OPTIONS = [
  { value: 1, label: "24h", accessibilityLabel: "Past 24 hours" },
  { value: 7, label: "7d", accessibilityLabel: "Past 7 days" },
  { value: 30, label: "30d", accessibilityLabel: "Past 30 days" },
  { value: 90, label: "90d", accessibilityLabel: "Past 90 days" },
] as const;

export const CHART_HEIGHT = 180;
export const WIDE_CHART_HEIGHT = 260;
// Below this the page keeps the phone's single column.
export const WIDE_WIDTH = 600;
export const MAX_CONTENT_WIDTH = 1080;
export const providerLabel = (provider: UsageProviderKind) => PROVIDER_LABEL[provider];
const CURSOR_KEYCHAIN_COPY = "Requires access to your Cursor login in macOS Keychain.";

export function UsageRouteScreen(props: { readonly workspace?: boolean }) {
  const route = useRoute<RouteProp<{ Usage: { tab?: string } | undefined }, "Usage">>();
  return <UsageScreen workspace={props.workspace} tabParam={route.params?.tab} />;
}

export function UsageUpdating({
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
    const result = await updateSettings({
      environmentId,
      input: { patch: { cursorKeychainUsageEnabled: true } },
    }).finally(() => setPending(false));
    if (result._tag === "Success") onEnabled();
  };
  return (
    <Button
      label={buttonText}
      tone="primary"
      accessibilityLabel={`Enable Cursor usage from ${label}`}
      accessibilityHint={CURSOR_KEYCHAIN_COPY}
      disabled={pending}
      onPress={() => void enable()}
      loading={pending}
    />
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

export function CursorEnableLimits({
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

export function ChartCard(props: {
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
  const chart = hasActivity ? (
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

export function UsageSummary(props: { readonly merged: MergedUsage; readonly metric: UsageChartMetric }) {
  const { merged, metric } = props;
  return (
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
  );
}

export function ProviderSection(props: {
  readonly merged: MergedUsage;
  readonly metric: UsageChartMetric;
  readonly cursorAccessEnvironments: readonly EnvironmentUsageStatus[];
  readonly showCursorEnvironment: boolean;
  readonly onCursorEnabled: () => void;
  /** Drops the share bar so the list fits beside the chart. */
  readonly compact: boolean;
}) {
  const { merged, metric } = props;
  const colors = useProviderColors();
  if (merged.providers.length === 0 && props.cursorAccessEnvironments.length === 0) return null;

  // Hermes lacks toSorted.
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
                ? `${formatPercent(share)} of cost · ${formatTokens(provider.totalTokens)} tokens`
                : `${formatPercent(share)} of tokens · ${formatUsd(provider.costUsd)}`}
            </Text>
          </View>
        );
      })}
    </SettingsSection>
  );
}

export function TotalsSection(props: {
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
          value={formatUsd(merged.costQuality.cacheSavingsUsd)}
          detail={
            merged.costUsd > 0
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

export function CostSection(props: { readonly merged: MergedUsage; readonly wide: boolean }) {
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

export function ModelsSection(props: {
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
      </View>
    </SettingsSection>
  );
}

export function usageEnvironmentStatus(environment: EnvironmentUsageStatus, refreshing: boolean): string {
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
