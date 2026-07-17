import type { EnvironmentId } from "@t3tools/contracts";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { useThemeColor } from "../../lib/useThemeColor";
import { useEnvironments } from "../../state/environments";
import {
  aggregateProviderUsage,
  areProviderUsageResultsComplete,
  formatCredits,
  formatResetsIn,
  percentLeft,
  providerUsageCreditsHaveMeter,
  providerUsageCreditsUsedPercent,
  type EnvironmentUsageInput,
  type NodeStatus,
  type ProviderUsageCard as ProviderUsageCardData,
} from "../../state/providerUsage";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

export function SettingsProviderUsageRouteScreen() {
  const insets = useSafeAreaInsets();
  const mutedColor = useThemeColor("--color-foreground-muted");
  const iconColor = useThemeColor("--color-icon");
  const { isReady, environments } = useEnvironments();

  const sortedEnvironments = useMemo(
    () => [...environments].sort((a, b) => a.label.localeCompare(b.label)),
    [environments],
  );

  const [results, setResults] = useState<Record<string, EnvironmentUsageInput>>({});
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);

  const handleResult = useCallback((next: EnvironmentUsageInput) => {
    setResults((prev) => {
      const existing = prev[next.environmentId];
      if (
        existing &&
        existing.snapshots === next.snapshots &&
        existing.isPending === next.isPending &&
        existing.error === next.error &&
        existing.environmentLabel === next.environmentLabel
      ) {
        return prev;
      }
      return { ...prev, [next.environmentId]: next };
    });
  }, []);

  const handleRemove = useCallback((environmentId: string) => {
    setResults((prev) => {
      if (!(environmentId in prev)) return prev;
      const next = { ...prev };
      delete next[environmentId];
      return next;
    });
  }, []);

  // Aggregate only the environments still mounted, in their sorted order, so a
  // disconnected node's stale result never lingers in the merged view.
  const aggregate = useMemo(() => {
    const inputs = sortedEnvironments
      .map((environment) => results[environment.environmentId])
      .filter((value): value is EnvironmentUsageInput => value !== undefined);
    return aggregateProviderUsage(inputs);
  }, [results, sortedEnvironments]);

  const handleRefresh = useCallback(() => {
    setRefreshNonce((value) => value + 1);
  }, []);

  // Deterministic pull-to-refresh spinner. The usage atoms are stale-while-
  // revalidate, so their `waiting` flag never cleanly settles (it lingers
  // through background revalidation across environments) — driving the
  // RefreshControl off it leaves the spinner stuck. Instead show it for a
  // bounded window each pull and let cards update as environments resolve.
  // Matches the isPullRefreshing pattern in GitOverviewSheet.
  useEffect(() => {
    if (refreshNonce === 0) return;
    setIsPullRefreshing(true);
    const timeout = setTimeout(() => setIsPullRefreshing(false), 1000);
    return () => clearTimeout(timeout);
  }, [refreshNonce]);

  const nowMs = Date.now();
  const hasContent =
    aggregate.cards.length > 0 ||
    aggregate.pendingNodes.length > 0 ||
    aggregate.failedNodes.length > 0;
  const hasAllResults = areProviderUsageResultsComplete(
    sortedEnvironments.map((environment) => environment.environmentId),
    results,
  );
  const isInitialLoading =
    isReady && !hasContent && sortedEnvironments.length > 0 && !hasAllResults;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {sortedEnvironments.map((environment) => (
        <EnvironmentUsageProbe
          key={environment.environmentId}
          environmentId={environment.environmentId}
          environmentLabel={environment.label}
          refreshNonce={refreshNonce}
          onResult={handleResult}
          onRemove={handleRemove}
        />
      ))}

      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentInset={{ bottom: Math.max(insets.bottom, 18) }}
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4 pb-[18px]"
        refreshControl={
          <RefreshControl
            refreshing={isPullRefreshing}
            onRefresh={handleRefresh}
            tintColor={mutedColor}
          />
        }
      >
        {!isReady || isInitialLoading ? (
          <View className="items-center gap-3 px-6 py-16">
            <ActivityIndicator />
            <Text className="text-center text-sm text-foreground-muted">Loading usage…</Text>
          </View>
        ) : !hasContent ? (
          <View className="items-center gap-2 px-6 py-16">
            <SymbolView
              name="gauge.with.needle"
              size={30}
              tintColor={iconColor}
              type="monochrome"
              weight="regular"
            />
            <Text className="text-center text-base text-foreground">No usage to show</Text>
            <Text className="text-center text-sm text-foreground-muted">
              Connect an environment signed in to a provider to see its subscription limits here.
            </Text>
          </View>
        ) : (
          <View className="gap-2">
            <Text className="px-2 text-sm font-t3-medium text-foreground-muted">Providers</Text>
            <View className="gap-3">
              {aggregate.cards.map((card) => (
                <ProviderUsageCard key={card.key} card={card} nowMs={nowMs} />
              ))}
              {aggregate.pendingNodes.map((node) => (
                <NodeStatusRow key={`pending:${node.environmentId}`} node={node} kind="pending" />
              ))}
              {aggregate.failedNodes.map((node) => (
                <NodeStatusRow key={`failed:${node.environmentId}`} node={node} kind="failed" />
              ))}
            </View>
            <Text className="px-2 pt-1 text-xs leading-normal text-foreground-muted">
              Usage reflects your provider subscription's rate-limit windows. Pull to refresh.
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

/**
 * One environment's usage subscription. Renders nothing — it exists so each
 * environment's `useEnvironmentQuery` hook is called at a stable position
 * (rules of hooks) while the list of environments changes. Results and refresh
 * are lifted to the screen, which aggregates across all probes.
 */
function EnvironmentUsageProbe(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly refreshNonce: number;
  readonly onResult: (result: EnvironmentUsageInput) => void;
  readonly onRemove: (environmentId: string) => void;
}) {
  const { environmentId, environmentLabel, refreshNonce, onResult, onRemove } = props;
  const query = useEnvironmentQuery(serverEnvironment.providerUsage({ environmentId, input: {} }));
  const snapshots = query.data ? query.data.usage : null;

  useEffect(() => {
    onResult({
      environmentId,
      environmentLabel,
      snapshots,
      isPending: query.isPending,
      error: query.error,
    });
  }, [environmentId, environmentLabel, snapshots, query.isPending, query.error, onResult]);

  useEffect(() => () => onRemove(environmentId), [environmentId, onRemove]);

  // Refresh on demand without re-subscribing when the refresh fn's identity
  // changes between renders.
  const refreshRef = useRef(query.refresh);
  refreshRef.current = query.refresh;
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    refreshRef.current();
  }, [refreshNonce]);

  return null;
}

function ProviderUsageCard(props: {
  readonly card: ProviderUsageCardData;
  readonly nowMs: number;
}) {
  const { card, nowMs } = props;
  const subtitle = buildSubtitle(card.account, card.sourceNodes);

  return (
    <View className="gap-4 rounded-[28px] border-continuous bg-card p-5">
      <View className="flex-row items-center gap-3">
        <ProviderIcon provider={card.driver} size={26} />
        <View className="min-w-0 flex-1">
          <Text className="text-lg font-t3-medium text-foreground" numberOfLines={1}>
            {card.displayName}
          </Text>
          {subtitle ? (
            <Text
              className="text-sm text-foreground-muted"
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {subtitle}
            </Text>
          ) : null}
        </View>
        {card.planLabel ? (
          <View className="rounded-full bg-subtle px-3 py-1">
            <Text className="text-xs font-t3-medium text-foreground-secondary" numberOfLines={1}>
              {card.planLabel}
            </Text>
          </View>
        ) : null}
      </View>

      <ProviderUsageBody card={card} nowMs={nowMs} />
    </View>
  );
}

function ProviderUsageBody(props: {
  readonly card: ProviderUsageCardData;
  readonly nowMs: number;
}) {
  const { card, nowMs } = props;
  const dangerColor = useThemeColor("--color-danger-foreground");
  const iconColor = useThemeColor("--color-icon");

  if (card.status === "ok") {
    const credits = card.credits ? formatCredits(card.credits) : null;
    if (card.windows.length === 0 && !credits) {
      return <Text className="text-sm text-foreground-muted">No active limits reported.</Text>;
    }
    return (
      <View className="gap-5">
        {card.windows.map((window) => (
          <UsageWindowRow
            key={window.id}
            label={window.label}
            usedPercent={window.usedPercent}
            resetsAt={window.resetsAt}
            nowMs={nowMs}
          />
        ))}
        {card.credits && credits ? (
          <UsageWindowRow
            label={card.credits.label}
            usedPercent={
              providerUsageCreditsHaveMeter(card.credits)
                ? providerUsageCreditsUsedPercent(card.credits)
                : null
            }
            valueText={credits}
          />
        ) : null}
      </View>
    );
  }

  if (card.status === "unsupported") {
    return (
      <Text className="text-sm text-foreground-muted">
        Usage isn't available for this provider.
      </Text>
    );
  }

  const isError = card.status === "error";
  return (
    <View className="flex-row items-start gap-3">
      <SymbolView
        name={isError ? "exclamationmark.triangle" : "person.crop.circle.badge.exclamationmark"}
        size={20}
        tintColor={isError ? dangerColor : iconColor}
        type="monochrome"
        weight="regular"
      />
      <Text
        className={
          isError
            ? "flex-1 text-sm text-danger-foreground"
            : "flex-1 text-sm text-foreground-secondary"
        }
      >
        {card.message ??
          (isError ? "Couldn't load usage." : "Sign in to this provider to see usage.")}
      </Text>
    </View>
  );
}

function UsageWindowRow(props: {
  readonly label: string;
  readonly usedPercent: number | null;
  readonly resetsAt?: string;
  readonly nowMs?: number;
  /** Overrides the "% left" line (used for credit balances). */
  readonly valueText?: string;
}) {
  const resets = props.nowMs !== undefined ? formatResetsIn(props.resetsAt, props.nowMs) : null;
  const left =
    props.valueText ??
    (props.usedPercent === null ? "" : `${Math.round(percentLeft(props.usedPercent))}% left`);
  return (
    <View className="gap-2">
      <Text className="text-sm text-foreground" numberOfLines={1}>
        {props.label}
      </Text>
      {props.usedPercent === null ? null : <UsageMeter usedPercent={props.usedPercent} />}
      <View className="flex-row items-center justify-between">
        <Text className="text-xs tabular-nums text-foreground-muted">{left}</Text>
        {resets ? <Text className="text-xs text-foreground-muted">{resets}</Text> : null}
      </View>
    </View>
  );
}

/**
 * A slim "% consumed" meter. The fill grows toward the limit and steps
 * green → amber → red as the window is exhausted.
 */
function UsageMeter(props: { readonly usedPercent: number }) {
  const trackColor = useThemeColor("--color-subtle");
  const okColor = useThemeColor("--color-switch-active");
  const warningColor = useThemeColor("--color-warning");
  const dangerColor = useThemeColor("--color-danger-foreground");
  const used = Math.max(0, Math.min(100, props.usedPercent));
  const fillColor = used >= 95 ? dangerColor : used >= 75 ? warningColor : okColor;

  return (
    <View className="h-2.5 overflow-hidden rounded-full" style={{ backgroundColor: trackColor }}>
      <View
        className="h-full rounded-full"
        style={{ width: `${Math.max(used, used > 0 ? 3 : 0)}%`, backgroundColor: fillColor }}
      />
    </View>
  );
}

function NodeStatusRow(props: { readonly node: NodeStatus; readonly kind: "pending" | "failed" }) {
  const mutedColor = useThemeColor("--color-foreground-muted");
  const dangerColor = useThemeColor("--color-danger-foreground");
  const isFailed = props.kind === "failed";
  return (
    <View className="flex-row items-center gap-3 rounded-[28px] border-continuous bg-card px-5 py-4">
      {isFailed ? (
        <SymbolView
          name="exclamationmark.triangle"
          size={18}
          tintColor={dangerColor}
          type="monochrome"
          weight="regular"
        />
      ) : (
        <ActivityIndicator color={mutedColor} />
      )}
      <View className="min-w-0 flex-1">
        <Text className="text-sm text-foreground" numberOfLines={1}>
          {props.node.environmentLabel}
        </Text>
        <Text
          className={isFailed ? "text-xs text-danger-foreground" : "text-xs text-foreground-muted"}
          numberOfLines={1}
        >
          {isFailed ? (props.node.error ?? "Unreachable") : "Loading usage…"}
        </Text>
      </View>
    </View>
  );
}

function buildSubtitle(
  account: string | undefined,
  sourceNodes: ReadonlyArray<string>,
): string | null {
  const parts: string[] = [];
  if (account) parts.push(account);
  if (sourceNodes.length > 1) parts.push(`via ${sourceNodes.join(", ")}`);
  else if (sourceNodes.length === 1) parts.push(sourceNodes[0]);
  return parts.length > 0 ? parts.join(" · ") : null;
}
