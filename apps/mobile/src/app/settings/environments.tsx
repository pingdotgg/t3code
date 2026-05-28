import { useAuth } from "@clerk/expo";
import { Link, Stack } from "expo-router";
import { SymbolView } from "expo-symbols";
import type { EnvironmentId } from "@t3tools/contracts";
import { RELAY_CLERK_TOKEN_OPTIONS } from "@t3tools/shared/relayAuth";
import * as Effect from "effect/Effect";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import {
  cloudEnvironmentsPendingStatus,
  type CloudEnvironmentRecordWithStatus,
  connectCloudEnvironment,
  listCloudEnvironments,
  loadCloudEnvironmentStatuses,
} from "../../features/cloud/linkEnvironment";
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
  const { getToken, isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const {
    connectedEnvironments,
    onReconnectEnvironment,
    onRemoveEnvironmentPress,
    onUpdateEnvironment,
  } = useRemoteConnections();
  const { savedConnectionsById } = useRemoteEnvironmentState();
  const insets = useSafeAreaInsets();
  const hasEnvironments = connectedEnvironments.length > 0;
  const [expandedId, setExpandedId] = useState<EnvironmentId | null>(null);
  const [cloudEnvironments, setCloudEnvironments] = useState<
    ReadonlyArray<CloudEnvironmentRecordWithStatus>
  >([]);
  const [cloudStatus, setCloudStatus] = useState<"idle" | "loading" | "error">("idle");
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [connectingCloudEnvironmentId, setConnectingCloudEnvironmentId] = useState<string | null>(
    null,
  );

  const primaryFg = useThemeColor("--color-primary-foreground");
  const accentColor = useThemeColor("--color-icon-muted");
  const iconColor = useThemeColor("--color-icon");

  const handleToggle = useCallback((environmentId: EnvironmentId) => {
    setExpandedId((prev) => (prev === environmentId ? null : environmentId));
  }, []);

  const availableCloudEnvironments = useMemo(
    () =>
      cloudEnvironments.filter(
        (record) => savedConnectionsById[record.environment.environmentId] === undefined,
      ),
    [cloudEnvironments, savedConnectionsById],
  );

  const refreshCloudEnvironments = useCallback(async () => {
    if (!isLoaded || !isSignedIn) {
      setCloudEnvironments([]);
      setCloudStatus("idle");
      setCloudError(null);
      return;
    }

    setCloudStatus("loading");
    setCloudError(null);
    try {
      const token = await getTokenRef.current(RELAY_CLERK_TOKEN_OPTIONS);
      if (!token) {
        setCloudEnvironments([]);
        setCloudStatus("idle");
        return;
      }
      const environments = await mobileRuntime.runPromise(
        listCloudEnvironments({ clerkToken: token }),
      );
      setCloudEnvironments(cloudEnvironmentsPendingStatus(environments));
      const records = await mobileRuntime.runPromise(
        loadCloudEnvironmentStatuses({ clerkToken: token, environments }),
      );
      setCloudEnvironments(records);
      setCloudStatus("idle");
    } catch (error) {
      setCloudStatus("error");
      setCloudError(
        error instanceof Error ? error.message : "Could not load T3 Cloud environments.",
      );
    }
  }, [isLoaded, isSignedIn]);

  useEffect(() => {
    void refreshCloudEnvironments();
  }, [refreshCloudEnvironments]);

  const handleConnectCloudEnvironment = useCallback(
    async (record: CloudEnvironmentRecordWithStatus) => {
      setConnectingCloudEnvironmentId(record.environment.environmentId);
      try {
        const token = await getToken(RELAY_CLERK_TOKEN_OPTIONS);
        if (!token) {
          throw new Error("Sign in to T3 Cloud before connecting.");
        }
        await mobileRuntime.runPromise(
          connectCloudEnvironment({
            clerkToken: token,
            environment: record.environment,
          }).pipe(Effect.flatMap(connectSavedEnvironment)),
        );
        setCloudEnvironments((records) =>
          records.filter(
            (candidate) => candidate.environment.environmentId !== record.environment.environmentId,
          ),
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

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <Stack.Screen
        options={{
          title: "Environments",
          headerRight: () => (
            <Link href="/settings/environment-new" asChild>
              <Pressable className="h-10 w-10 items-center justify-center rounded-full bg-primary active:opacity-70">
                <SymbolView
                  name="plus"
                  size={18}
                  tintColor={primaryFg}
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

        {isSignedIn ? (
          <View collapsable={false} className="mt-5 gap-3">
            <View className="flex-row items-center justify-between px-1">
              <Text className="text-[13px] font-t3-bold uppercase text-foreground-muted">
                T3 Cloud
              </Text>
              <Pressable
                accessibilityRole="button"
                disabled={cloudStatus === "loading"}
                onPress={refreshCloudEnvironments}
                className="h-9 w-9 items-center justify-center rounded-full bg-subtle active:opacity-70 disabled:opacity-50"
              >
                {cloudStatus === "loading" ? (
                  <ActivityIndicator color={iconColor} size="small" />
                ) : (
                  <SymbolView
                    name="arrow.clockwise"
                    size={14}
                    tintColor={iconColor}
                    type="monochrome"
                  />
                )}
              </Pressable>
            </View>

            {availableCloudEnvironments.length > 0 ? (
              <View collapsable={false} className="overflow-hidden rounded-[24px] bg-card">
                {availableCloudEnvironments.map((record, index) => (
                  <CloudEnvironmentRow
                    key={record.environment.environmentId}
                    record={record}
                    borderTop={index !== 0}
                    isConnecting={connectingCloudEnvironmentId === record.environment.environmentId}
                    onConnect={() => handleConnectCloudEnvironment(record)}
                  />
                ))}
              </View>
            ) : cloudStatus === "loading" ? (
              <View
                collapsable={false}
                className="items-center gap-3 rounded-[24px] bg-card px-6 py-6"
              >
                <ActivityIndicator color={iconColor} />
                <Text className="text-center text-[14px] leading-[20px] text-foreground-muted">
                  Loading linked cloud environments.
                </Text>
              </View>
            ) : cloudStatus === "error" ? (
              <View collapsable={false} className="gap-3 rounded-[24px] bg-card px-5 py-5">
                <Text className="text-[15px] font-t3-bold text-foreground">
                  Could not load T3 Cloud environments
                </Text>
                <Text className="text-[13px] leading-[18px] text-foreground-muted">
                  {cloudError}
                </Text>
              </View>
            ) : (
              <View collapsable={false} className="rounded-[24px] bg-card px-5 py-5">
                <Text className="text-[14px] leading-[20px] text-foreground-muted">
                  No additional linked cloud environments.
                </Text>
              </View>
            )}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function CloudEnvironmentRow(props: {
  readonly record: CloudEnvironmentRecordWithStatus;
  readonly borderTop: boolean;
  readonly isConnecting: boolean;
  readonly onConnect: () => void;
}) {
  const mutedColor = useThemeColor("--color-icon-muted");
  const { environment, status, statusError } = props.record;
  const disabled = props.isConnecting;
  const statusText =
    status === null
      ? (statusError ?? "Status unavailable")
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
          {environment.label}
        </Text>
        <Text className="text-[12px] leading-[16px] text-foreground-muted" numberOfLines={1}>
          {environment.endpoint.httpBaseUrl}
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
