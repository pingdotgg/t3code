import { T, useGT } from "gt-react-native";
import * as Dialog from "../../components/ui/Dialog";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { type EnvironmentMachineKind, resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ENVIRONMENT_MACHINE_SYMBOLS } from "../../components/EnvironmentMachineSymbol";
import {
  clearClientCacheAtom,
  clientCacheSummaryAtom,
  type EnvironmentClientCacheSummary,
} from "../../state/client-cache-state";
import { useServerConfigs } from "../../state/entities";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";
import { formatBytes } from "../../lib/formatBytes";

export function SettingsClientStorageRouteScreen() {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const summaryResult = useAtomValue(clientCacheSummaryAtom);
  const clearResult = useAtomValue(clearClientCacheAtom);
  const clearCache = useAtomSet(clearClientCacheAtom);
  const { savedConnectionsById } = useSavedRemoteConnections();
  const serverConfigs = useServerConfigs();
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
    Dialog.confirm({
      title: gt("Clear cache for {environment}?", { environment: label }),
      message: gt(
        "This removes offline threads, server metadata, and cached branches for this environment. The saved connection and credentials stay intact.",
      ),
      confirmText: gt("Clear Cache"),
      destructive: true,
      onConfirm: () =>
        clearCache({ type: "environment", environmentId: environment.environmentId }),
    });
  };

  const confirmClearAll = () => {
    Dialog.confirm({
      title: gt("Clear all client caches?"),
      message: gt(
        "This removes offline data for every environment. Connections, credentials, account data, and app preferences stay intact.",
      ),
      confirmText: gt("Clear All Caches"),
      destructive: true,
      onConfirm: () => clearCache({ type: "all" }),
    });
  };

  return (
    <SettingsScreen title={gt("Client Storage")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title={gt("Environment caches")}>
          {AsyncResult.isFailure(summaryResult) ? (
            <View className="items-center gap-2 px-6 py-8">
              <SymbolView
                name="exclamationmark.triangle"
                size={28}
                tintColorClassName="accent-danger-foreground"
                type="monochrome"
                weight="regular"
              />
              <Text className="text-center text-base text-foreground">
                <T>Storage unavailable</T>
              </Text>
              <Text className="text-center text-sm text-foreground-muted">
                <T>Restart the app and try again.</T>
              </Text>
            </View>
          ) : !summary ? (
            <View className="items-center gap-3 px-6 py-8">
              <AppActivityIndicator />
              <Text className="text-center text-sm text-foreground-muted">
                <T>Inspecting cached data…</T>
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
                machine={resolveEnvironmentMachineKind(
                  serverConfigs.get(environment.environmentId) ?? null,
                )}
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
                tintColorClassName="accent-icon"
                type="monochrome"
                weight="regular"
              />
              <Text className="text-center text-base text-foreground">
                <T>No cached data</T>
              </Text>
              <Text className="text-center text-sm text-foreground-muted">
                <T>Offline cache records will appear here after environments are used.</T>
              </Text>
            </View>
          )}
        </SettingsSection>

        <View className="gap-3">
          <SettingsSection title={gt("Actions")}>
            <SettingsActionRow
              icon="trash"
              label={
                summary
                  ? gt("Clear {size}", { size: formatBytes(summary.payloadBytes) })
                  : gt("Clear caches")
              }
              tone="danger"
              disabled={isClearing || !summary || summary.recordCount === 0}
              loading={isClearing}
              onPress={confirmClearAll}
            />
          </SettingsSection>
          <Text className="px-2 text-sm leading-normal text-foreground-muted">
            <T>
              Clearing caches never removes environment connections, credentials, account data, or
              appearance preferences.
            </T>
          </Text>
          {AsyncResult.isFailure(summaryResult) || AsyncResult.isFailure(clearResult) ? (
            <Text selectable className="px-2 text-sm text-danger-foreground">
              <T>Client storage is temporarily unavailable. Try again after restarting the app.</T>
            </Text>
          ) : null}
        </View>
      </ScrollView>
    </SettingsScreen>
  );
}

function CacheEnvironmentRow(props: {
  readonly environment: EnvironmentClientCacheSummary;
  readonly environmentLabel: string;
  readonly machine: EnvironmentMachineKind;
  readonly disabled: boolean;
  readonly first: boolean;
  readonly onClear: () => void;
}) {
  const gt = useGT();
  return (
    <View className={props.first ? undefined : "border-t border-border"}>
      <SettingsActionRow
        icon={ENVIRONMENT_MACHINE_SYMBOLS[props.machine]}
        label={props.environmentLabel}
        description={gt("Clear {size} of cached data", {
          size: formatBytes(props.environment.payloadBytes),
        })}
        tone="danger"
        disabled={props.disabled}
        onPress={props.onClear}
      />
    </View>
  );
}
