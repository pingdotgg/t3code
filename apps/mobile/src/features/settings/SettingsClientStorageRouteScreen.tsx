import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { SymbolView } from "expo-symbols";
import { useMemo } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  clearClientCacheAtom,
  clientCacheSummaryAtom,
  type EnvironmentClientCacheSummary,
} from "../../state/client-cache-state";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsSection } from "./components/SettingsSection";

export function SettingsClientStorageRouteScreen() {
  const insets = useSafeAreaInsets();
  const iconColor = useThemeColor("--color-icon");
  const dangerForegroundColor = useThemeColor("--color-danger-foreground");
  const summaryResult = useAtomValue(clientCacheSummaryAtom);
  const clearResult = useAtomValue(clearClientCacheAtom);
  const clearCache = useAtomSet(clearClientCacheAtom);
  const { savedConnectionsById } = useSavedRemoteConnections();
  const isClearing = clearResult.waiting;
  const summary = AsyncResult.isSuccess(summaryResult) ? summaryResult.value : null;
  const environmentSummaries = useMemo(
    () =>
      [...(summary?.environments ?? [])].sort((left, right) => {
        const leftLabel = savedConnectionsById[left.environmentId]?.environmentLabel ?? "";
        const rightLabel = savedConnectionsById[right.environmentId]?.environmentLabel ?? "";
        return leftLabel.localeCompare(rightLabel);
      }),
    [savedConnectionsById, summary?.environments],
  );

  const confirmClearEnvironment = (environment: EnvironmentClientCacheSummary) => {
    const label =
      savedConnectionsById[environment.environmentId]?.environmentLabel ??
      environment.environmentId;
    Alert.alert(
      `Clear cache for ${label}?`,
      "This removes offline threads, server metadata, and cached branches for this environment. The saved connection and credentials stay intact.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear Cache",
          style: "destructive",
          onPress: () =>
            clearCache({ type: "environment", environmentId: environment.environmentId }),
        },
      ],
    );
  };

  const confirmClearAll = () => {
    Alert.alert(
      "Clear all client caches?",
      "This removes offline data for every environment. Connections, credentials, account data, and app preferences stay intact.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear All Caches",
          style: "destructive",
          onPress: () => clearCache({ type: "all" }),
        },
      ],
    );
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentInset={{ bottom: Math.max(insets.bottom, 18) }}
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4 pb-[18px]"
      >
        <SettingsSection title="Environment caches">
          {AsyncResult.isFailure(summaryResult) ? (
            <View className="items-center gap-2 px-6 py-8">
              <SymbolView
                name="exclamationmark.triangle"
                size={28}
                tintColor={dangerForegroundColor}
                type="monochrome"
                weight="regular"
              />
              <Text className="text-center text-base text-foreground">Storage unavailable</Text>
              <Text className="text-center text-sm text-foreground-muted">
                Restart the app and try again.
              </Text>
            </View>
          ) : !summary ? (
            <View className="items-center gap-3 px-6 py-8">
              <ActivityIndicator />
              <Text className="text-center text-sm text-foreground-muted">
                Inspecting cached data…
              </Text>
            </View>
          ) : environmentSummaries.length > 0 ? (
            environmentSummaries.map((environment, index) => (
              <CacheEnvironmentRow
                key={environment.environmentId}
                environment={environment}
                environmentLabel={
                  savedConnectionsById[environment.environmentId]?.environmentLabel ??
                  environment.environmentId
                }
                disabled={isClearing}
                first={index === 0}
                onClear={() => confirmClearEnvironment(environment)}
              />
            ))
          ) : (
            <View className="items-center gap-2 px-6 py-8">
              <SymbolView
                name="checkmark.circle"
                size={28}
                tintColor={iconColor}
                type="monochrome"
                weight="regular"
              />
              <Text className="text-center text-base text-foreground">No cached data</Text>
              <Text className="text-center text-sm text-foreground-muted">
                Offline cache records will appear here after environments are used.
              </Text>
            </View>
          )}
        </SettingsSection>

        <View className="gap-3">
          <SettingsSection title="Actions">
            <Pressable
              accessibilityRole="button"
              disabled={isClearing || !summary || summary.recordCount === 0}
              onPress={confirmClearAll}
              className="flex-row items-center gap-4 p-4 disabled:opacity-40"
            >
              <SymbolView
                name="trash"
                size={22}
                tintColor={dangerForegroundColor}
                type="monochrome"
                weight="regular"
              />
              <Text className="flex-1 text-lg tabular-nums text-danger-foreground">
                {summary ? `Clear ${formatBytes(summary.payloadBytes)}` : "Clear caches"}
              </Text>
              {isClearing ? <ActivityIndicator color={dangerForegroundColor} /> : null}
            </Pressable>
          </SettingsSection>
          <Text className="px-2 text-sm leading-normal text-foreground-muted">
            Clearing caches never removes environment connections, credentials, account data, or
            appearance preferences.
          </Text>
          {AsyncResult.isFailure(summaryResult) || AsyncResult.isFailure(clearResult) ? (
            <Text selectable className="px-2 text-sm text-danger-foreground">
              Client storage is temporarily unavailable. Try again after restarting the app.
            </Text>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

function CacheEnvironmentRow(props: {
  readonly environment: EnvironmentClientCacheSummary;
  readonly environmentLabel: string;
  readonly disabled: boolean;
  readonly first: boolean;
  readonly onClear: () => void;
}) {
  const iconColor = useThemeColor("--color-icon");
  return (
    <View
      className={
        props.first
          ? "flex-row items-center gap-3 p-4"
          : "border-t border-border flex-row items-center gap-3 p-4"
      }
    >
      <SymbolView
        name="desktopcomputer"
        size={22}
        tintColor={iconColor}
        type="monochrome"
        weight="regular"
      />
      <Text className="min-w-0 flex-1 text-base text-foreground" numberOfLines={1}>
        {props.environmentLabel}
      </Text>
      <Pressable
        accessibilityLabel={`Clear cache for ${props.environmentLabel}`}
        accessibilityRole="button"
        disabled={props.disabled}
        onPress={props.onClear}
        className="rounded-full px-3 py-2 disabled:opacity-40"
      >
        <Text className="font-t3-medium tabular-nums text-danger-foreground" numberOfLines={1}>
          Clear {formatBytes(props.environment.payloadBytes)}
        </Text>
      </Pressable>
    </View>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
