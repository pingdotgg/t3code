import { useAuth } from "@clerk/expo";
import { Link, Stack } from "expo-router";
import { SymbolView } from "expo-symbols";
import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import { RELAY_CLERK_TOKEN_OPTIONS } from "@t3tools/shared/relayAuth";
import * as Effect from "effect/Effect";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { connectCloudEnvironment } from "../../features/cloud/linkEnvironment";
import { hasCloudPublicConfig } from "../../features/cloud/publicConfig";
import {
  useManagedRelayEnvironments,
  useManagedRelayEnvironmentStatus,
} from "../../features/cloud/managedRelayState";
import { ConnectionEnvironmentRow } from "../../features/connection/ConnectionEnvironmentRow";
import { cn } from "../../lib/cn";
import { mobileRuntime } from "../../lib/runtime";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  connectSavedEnvironment,
  useRemoteConnections,
  useRemoteEnvironmentState,
} from "../../state/use-remote-environment-registry";

export default function SettingsEnvironmentsRouteScreen() {
  const {
    connectedEnvironments,
    onReconnectEnvironment,
    onRemoveEnvironmentPress,
    onUpdateEnvironment,
  } = useRemoteConnections();
  const insets = useSafeAreaInsets();
  const hasEnvironments = connectedEnvironments.length > 0;
  const [expandedId, setExpandedId] = useState<EnvironmentId | null>(null);
  const accentColor = useThemeColor("--color-icon-muted");
  const iconColor = useThemeColor("--color-icon");

  const handleToggle = useCallback((environmentId: EnvironmentId) => {
    setExpandedId((prev) => (prev === environmentId ? null : environmentId));
  }, []);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <Stack.Screen
        options={{
          title: "Environments",
          headerRight: () => (
            <Link href="/settings/environment-new" asChild>
              <Pressable
                accessibilityLabel="Add environment"
                accessibilityRole="button"
                className="h-10 w-10 items-center justify-center active:opacity-70"
              >
                <SymbolView
                  name="plus"
                  size={18}
                  tintColor={iconColor}
                  type="monochrome"
                  weight="semibold"
                />
              </Pressable>
            </Link>
          ),
        }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
          paddingHorizontal: 20,
          paddingTop: 16,
        }}
      >
        {hasEnvironments ? (
          <View collapsable={false} className="overflow-hidden rounded-[24px] bg-card">
            {connectedEnvironments.map((environment, index) => (
              <View
                key={environment.environmentId}
                collapsable={false}
                style={{
                  borderTopWidth: index === 0 ? 0 : 1,
                }}
                className={cn(index !== 0 && "border-border")}
              >
                <ConnectionEnvironmentRow
                  environment={environment}
                  expanded={expandedId === environment.environmentId}
                  onToggle={() => handleToggle(environment.environmentId)}
                  onReconnect={onReconnectEnvironment}
                  onRemove={onRemoveEnvironmentPress}
                  onUpdate={onUpdateEnvironment}
                />
              </View>
            ))}
          </View>
        ) : (
          <View collapsable={false} className="items-center gap-3 rounded-[24px] bg-card px-6 py-8">
            <View className="h-12 w-12 items-center justify-center rounded-[16px] bg-subtle">
              <SymbolView
                name="point.3.connected.trianglepath.dotted"
                size={20}
                tintColor={accentColor}
                type="monochrome"
              />
            </View>
            <Text className="text-center text-[14px] leading-[20px] text-foreground-muted">
              No environments connected yet.{"\n"}Tap{" "}
              <Text className="font-t3-bold text-foreground">+</Text> to add one.
            </Text>
          </View>
        )}

        {hasCloudPublicConfig() ? <ConfiguredCloudEnvironmentRows /> : null}
      </ScrollView>
    </View>
  );
}

function ConfiguredCloudEnvironmentRows() {
  const { getToken, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { savedConnectionsById } = useRemoteEnvironmentState();
  const cloudEnvironmentsState = useManagedRelayEnvironments();
  const [connectingCloudEnvironmentId, setConnectingCloudEnvironmentId] = useState<string | null>(
    null,
  );
  const iconColor = useThemeColor("--color-icon");
  const availableCloudEnvironments = useMemo(
    () =>
      (cloudEnvironmentsState.data ?? []).filter(
        (environment) => savedConnectionsById[environment.environmentId] === undefined,
      ),
    [cloudEnvironmentsState.data, savedConnectionsById],
  );

  const handleConnectCloudEnvironment = useCallback(
    async (environment: RelayClientEnvironmentRecord) => {
      setConnectingCloudEnvironmentId(environment.environmentId);
      try {
        const token = await getToken(RELAY_CLERK_TOKEN_OPTIONS);
        if (!token) {
          throw new Error("Sign in to T3 Cloud before connecting.");
        }
        await mobileRuntime.runPromise(
          connectCloudEnvironment({
            clerkToken: token,
            environment,
          }).pipe(Effect.flatMap(connectSavedEnvironment)),
        );
      } catch (error) {
        Alert.alert(
          "Connect failed",
          error instanceof Error ? error.message : "Could not connect to this environment.",
        );
      } finally {
        setConnectingCloudEnvironmentId(null);
      }
    },
    [getToken],
  );

  if (!isSignedIn) return null;

  return (
    <View collapsable={false} className="mt-5 gap-3">
      <View className="flex-row items-center justify-between px-1">
        <Text className="text-[13px] font-t3-bold uppercase text-foreground-muted">T3 Cloud</Text>
        <Pressable
          accessibilityRole="button"
          disabled={cloudEnvironmentsState.isPending}
          onPress={cloudEnvironmentsState.refresh}
          className="h-9 w-9 items-center justify-center rounded-full bg-subtle active:opacity-70 disabled:opacity-50"
        >
          {cloudEnvironmentsState.isPending ? (
            <ActivityIndicator color={iconColor} size="small" />
          ) : (
            <SymbolView name="arrow.clockwise" size={14} tintColor={iconColor} type="monochrome" />
          )}
        </Pressable>
      </View>

      {availableCloudEnvironments.length > 0 ? (
        <View collapsable={false} className="overflow-hidden rounded-[24px] bg-card">
          {availableCloudEnvironments.map((environment, index) => (
            <CloudEnvironmentRow
              key={environment.environmentId}
              environment={environment}
              borderTop={index !== 0}
              isConnecting={connectingCloudEnvironmentId === environment.environmentId}
              onConnect={() => handleConnectCloudEnvironment(environment)}
            />
          ))}
        </View>
      ) : cloudEnvironmentsState.data === null ? (
        <View collapsable={false} className="items-center gap-3 rounded-[24px] bg-card p-6">
          <ActivityIndicator color={iconColor} />
          <Text className="text-center text-[14px] leading-[20px] text-foreground-muted">
            Loading linked cloud environments.
          </Text>
        </View>
      ) : cloudEnvironmentsState.error ? (
        <View collapsable={false} className="gap-3 rounded-[24px] bg-card p-5">
          <Text className="text-[15px] font-t3-bold text-foreground">
            Could not load T3 Cloud environments
          </Text>
          <Text className="text-[13px] leading-[18px] text-foreground-muted">
            {cloudEnvironmentsState.error}
          </Text>
        </View>
      ) : (
        <View collapsable={false} className="rounded-[24px] bg-card p-5">
          <Text className="text-[14px] leading-[20px] text-foreground-muted">
            No additional linked cloud environments.
          </Text>
        </View>
      )}
    </View>
  );
}

function CloudEnvironmentRow(props: {
  readonly environment: RelayClientEnvironmentRecord;
  readonly borderTop: boolean;
  readonly isConnecting: boolean;
  readonly onConnect: () => void;
}) {
  const mutedColor = useThemeColor("--color-icon-muted");
  const statusState = useManagedRelayEnvironmentStatus(props.environment);
  const status = statusState.data;
  const disabled = props.isConnecting;
  const statusText =
    status === null
      ? (statusState.error ?? (statusState.isPending ? "Checking status..." : "Status unavailable"))
      : status.status === "online"
        ? "Online"
        : (status.error ?? "Offline");

  return (
    <View
      collapsable={false}
      className={cn(
        "flex-row items-center gap-3 bg-card px-4 py-3.5",
        props.borderTop && "border-t border-border",
      )}
    >
      <View className="h-9 w-9 items-center justify-center rounded-[14px] bg-subtle">
        <SymbolView
          name="cloud"
          size={17}
          tintColor={mutedColor}
          type="monochrome"
          weight="semibold"
        />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-[16px] font-t3-bold leading-[21px] text-foreground" numberOfLines={1}>
          {props.environment.label}
        </Text>
        <Text className="text-[12px] leading-[16px] text-foreground-muted" numberOfLines={1}>
          {props.environment.endpoint.httpBaseUrl}
        </Text>
        <Text className="text-[12px] leading-[16px] text-foreground-muted" numberOfLines={1}>
          {statusText}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        disabled={disabled}
        onPress={props.onConnect}
        className="min-h-[40px] min-w-[88px] items-center justify-center rounded-[14px] bg-primary px-4 active:opacity-70 disabled:opacity-50"
      >
        <Text className="text-[13px] font-t3-bold text-primary-foreground">
          {props.isConnecting ? "Connecting" : "Connect"}
        </Text>
      </Pressable>
    </View>
  );
}
