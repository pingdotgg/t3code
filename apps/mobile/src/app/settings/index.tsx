import { useAuth, useUser } from "@clerk/expo";
import * as Notifications from "expo-notifications";
import { Link, Stack, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import * as Effect from "effect/Effect";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import { Alert, Linking, Pressable, ScrollView, Switch, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { setLiveActivityUpdatesEnabled } from "../../features/agent-awareness/liveActivityPreferences";
import { requestAgentNotificationPermission } from "../../features/agent-awareness/notificationPermissions";
import { refreshAgentAwarenessRegistration } from "../../features/agent-awareness/remoteRegistration";
import { refreshManagedRelayEnvironments } from "../../features/cloud/managedRelayState";
import { useClerkSettingsSheetDetent } from "../../features/cloud/ClerkSettingsSheetDetent";
import {
  hasCloudPublicConfig,
  resolveRelayClerkTokenOptions,
} from "../../features/cloud/publicConfig";
import { mobileRuntime } from "../../lib/runtime";
import { loadPreferences } from "../../lib/storage";
import { useThemeColor } from "../../lib/useThemeColor";
import { useRemoteEnvironmentState } from "../../state/use-remote-environment-registry";

type NotificationStatus = "checking" | "enabled" | "disabled" | "unsupported";
type LiveActivityStatus = "checking" | "enabled" | "disabled" | "signed-out" | "linking";

export default function SettingsRouteScreen() {
  return hasCloudPublicConfig() ? <ConfiguredSettingsRouteScreen /> : <LocalSettingsRouteScreen />;
}

function LocalSettingsRouteScreen() {
  const insets = useSafeAreaInsets();
  const { savedConnectionsById } = useRemoteEnvironmentState();
  const environmentCount = Object.keys(savedConnectionsById).length;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <Stack.Screen options={{ title: "Settings" }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        style={{ flex: 1 }}
        contentContainerStyle={{
          gap: 24,
          paddingBottom: Math.max(insets.bottom, 18) + 18,
          paddingHorizontal: 20,
          paddingTop: 16,
        }}
      >
        <SettingsSection title="Configuration">
          <SettingsRow
            icon="desktopcomputer"
            label="Environments"
            value={`${environmentCount}`}
            href="/settings/environments"
          />
        </SettingsSection>

        <AppSettingsSection />
      </ScrollView>
    </View>
  );
}

function ConfiguredSettingsRouteScreen() {
  const insets = useSafeAreaInsets();
  const { push } = useRouter();
  const { expand: expandClerkSheet } = useClerkSettingsSheetDetent();
  const { getToken, isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { user } = useUser();
  const { savedConnectionsById } = useRemoteEnvironmentState();
  const [notificationStatus, setNotificationStatus] = useState<NotificationStatus>("checking");
  const [liveActivityStatus, setLiveActivityStatus] = useState<LiveActivityStatus>("checking");

  const connections = useMemo(() => Object.values(savedConnectionsById), [savedConnectionsById]);
  const environmentCount = connections.length;
  const accountLabel = useMemo(() => {
    if (!isLoaded) return "Checking";
    if (!isSignedIn) return "Request access";
    return user?.primaryEmailAddress?.emailAddress ?? "Signed in";
  }, [isLoaded, isSignedIn, user?.primaryEmailAddress?.emailAddress]);

  const refreshNotifications = useCallback(async () => {
    if (process.env.EXPO_OS !== "ios") {
      setNotificationStatus("unsupported");
      return;
    }
    const permission = await Notifications.getPermissionsAsync();
    setNotificationStatus(permission.granted ? "enabled" : "disabled");
  }, []);

  useEffect(() => {
    void refreshNotifications();
  }, [refreshNotifications]);

  useEffect(() => {
    if (!isLoaded) {
      setLiveActivityStatus("checking");
      return;
    }
    if (!isSignedIn) {
      setLiveActivityStatus("signed-out");
      return;
    }
    void loadPreferences().then(
      (preferences) => {
        setLiveActivityStatus(preferences.liveActivitiesEnabled === false ? "disabled" : "enabled");
      },
      () => {
        setLiveActivityStatus("enabled");
      },
    );
  }, [isLoaded, isSignedIn]);

  const requestNotifications = useCallback(async () => {
    try {
      const result = await mobileRuntime.runPromise(
        requestAgentNotificationPermission.pipe(
          Effect.tap((permission) =>
            permission.type === "granted" ? refreshAgentAwarenessRegistration() : Effect.void,
          ),
        ),
      );
      if (result.type === "granted") {
        setNotificationStatus("enabled");
        Alert.alert(
          "Notifications enabled",
          "Live Activity notifications are enabled for this device.",
        );
        return;
      }
      if (result.type === "unsupported") {
        setNotificationStatus("unsupported");
        Alert.alert(
          "Notifications unavailable",
          "Live Activity notifications are only available on iOS.",
        );
        return;
      }
      setNotificationStatus("disabled");
      if (result.canAskAgain) {
        Alert.alert("Notifications disabled", "Notifications were not enabled.");
        return;
      }
      Alert.alert(
        "Notifications disabled",
        "Notifications were denied for this app. Open Settings to enable them.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Open Settings", onPress: () => void Linking.openSettings() },
        ],
      );
    } catch (error) {
      Alert.alert(
        "Notifications unavailable",
        error instanceof Error ? error.message : "Could not request notification permission.",
      );
    }
  }, []);

  const promptSignIn = useCallback(() => {
    Alert.alert(
      "Request T3 Cloud access",
      "Live Activity updates require approved T3 Cloud access so relay can deliver updates to this device.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Continue", onPress: () => push("/settings/waitlist") },
      ],
    );
  }, [push]);

  const linkEnvironments = useCallback(async () => {
    if (!isSignedIn) {
      promptSignIn();
      return;
    }

    setLiveActivityStatus("linking");
    try {
      const token = await getToken(resolveRelayClerkTokenOptions());
      if (!token) {
        promptSignIn();
        setLiveActivityStatus("signed-out");
        return;
      }

      await mobileRuntime.runPromise(
        setLiveActivityUpdatesEnabled({
          enabled: true,
          clerkToken: token,
          connections,
        }),
      );
      refreshManagedRelayEnvironments();
      setLiveActivityStatus("enabled");
      Alert.alert(
        "Live Activities enabled",
        environmentCount > 0
          ? `${environmentCount} environment${environmentCount === 1 ? "" : "s"} linked for Live Activity updates.`
          : "Live Activity updates are enabled. Add an environment to start receiving updates.",
      );
    } catch (error) {
      setLiveActivityStatus("disabled");
      Alert.alert(
        "Live Activities unavailable",
        error instanceof Error ? error.message : "Could not enable Live Activity updates.",
      );
    }
  }, [connections, environmentCount, getToken, isSignedIn, promptSignIn]);

  const handleDeviceNotificationsChange = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        void requestNotifications();
        return;
      }

      Alert.alert(
        "Disable notifications",
        "Notification permission is controlled by iOS. Open Settings to disable notifications for T3 Code.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Open Settings", onPress: () => void Linking.openSettings() },
        ],
      );
    },
    [requestNotifications],
  );

  const handleLiveActivitiesChange = useCallback(
    (enabled: boolean) => {
      if (!enabled) {
        setLiveActivityStatus("disabled");
        void (async () => {
          try {
            const token = isSignedIn ? await getToken(resolveRelayClerkTokenOptions()) : null;
            await mobileRuntime.runPromise(
              setLiveActivityUpdatesEnabled({
                enabled: false,
                clerkToken: token,
                connections,
              }),
            );
            refreshManagedRelayEnvironments();
          } catch {
            // The switch is optimistic; a future refresh reconciles relay state.
          }
        })();
        return;
      }

      if (!isSignedIn) {
        promptSignIn();
        return;
      }

      void linkEnvironments();
    },
    [connections, getToken, isSignedIn, linkEnvironments, promptSignIn],
  );

  const openAccount = useCallback(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      push("/settings/waitlist");
      return;
    }
    expandClerkSheet();
    push("/settings/auth");
  }, [expandClerkSheet, isLoaded, isSignedIn, push]);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <Stack.Screen options={{ title: "Settings" }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        style={{ flex: 1 }}
        contentContainerStyle={{
          gap: 24,
          paddingBottom: Math.max(insets.bottom, 18) + 18,
          paddingHorizontal: 20,
          paddingTop: 16,
        }}
      >
        <View className="gap-3">
          <SettingsSection title="Account">
            <SettingsRow
              icon="person.crop.circle"
              label="T3 Account"
              value={accountLabel}
              onPress={openAccount}
            />
          </SettingsSection>
          <Text className="px-2 text-[13px] leading-[18px] text-foreground-muted">
            T3 Code works locally without signing in. Cloud features are optional.
          </Text>
        </View>

        <SettingsSection title="Configuration">
          <SettingsRow
            icon="desktopcomputer"
            label="Environments"
            value={`${environmentCount}`}
            href="/settings/environments"
          />
          <SettingsSwitchRow
            icon="bell.badge"
            label="Device Notifications"
            disabled={notificationStatus === "checking" || notificationStatus === "unsupported"}
            value={notificationStatus === "enabled"}
            onValueChange={handleDeviceNotificationsChange}
          />
          <SettingsSwitchRow
            disabled={
              !isLoaded || liveActivityStatus === "checking" || liveActivityStatus === "linking"
            }
            icon="bolt.circle"
            label="Live Activity Updates"
            value={liveActivityStatus === "enabled" || liveActivityStatus === "linking"}
            onValueChange={handleLiveActivitiesChange}
          />
        </SettingsSection>

        <AppSettingsSection />
      </ScrollView>
    </View>
  );
}

type SymbolName = ComponentProps<typeof SymbolView>["name"];

function SettingsSection(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <View className="gap-2">
      <Text className="px-2 text-[13px] font-t3-medium text-foreground-muted">{props.title}</Text>
      <View
        className="overflow-hidden rounded-[28px] bg-card"
        style={{ borderCurve: "continuous" }}
      >
        {props.children}
      </View>
    </View>
  );
}

function AppSettingsSection() {
  const icon = useThemeColor("--color-icon");

  return (
    <SettingsSection title="App">
      <View className="flex-row items-center gap-4 p-4">
        <SymbolView
          name="info.circle"
          size={22}
          tintColor={icon}
          type="monochrome"
          weight="regular"
        />
        <Text className="flex-1 text-[17px] text-foreground">Version</Text>
        <Text className="text-[17px] text-foreground-muted">Alpha</Text>
      </View>
    </SettingsSection>
  );
}

function SettingsRow(props: {
  readonly disabled?: boolean;
  readonly icon: SymbolName;
  readonly label: string;
  readonly value?: string;
  readonly href?: "/settings/environments";
  readonly onPress?: () => void;
}) {
  const icon = useThemeColor("--color-icon");
  const chevron = useThemeColor("--color-chevron");
  const content = (
    <View
      className="flex-row items-center gap-4 p-4"
      style={{ opacity: props.disabled ? 0.45 : 1 }}
    >
      <SymbolView name={props.icon} size={22} tintColor={icon} type="monochrome" weight="regular" />
      <Text className="flex-1 text-[17px] text-foreground">{props.label}</Text>
      {props.value ? (
        <Text
          className="max-w-[180px] text-right text-[16px] text-foreground-muted"
          numberOfLines={1}
        >
          {props.value}
        </Text>
      ) : null}
      <SymbolView
        name="chevron.right"
        size={16}
        tintColor={chevron}
        type="monochrome"
        weight="semibold"
      />
    </View>
  );

  if (props.href) {
    return (
      <Link href={props.href} asChild>
        <Pressable>{content}</Pressable>
      </Link>
    );
  }

  return (
    <Pressable accessibilityRole="button" disabled={props.disabled} onPress={props.onPress}>
      {content}
    </Pressable>
  );
}

function SettingsSwitchRow(props: {
  readonly disabled?: boolean;
  readonly icon: SymbolName;
  readonly label: string;
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
}) {
  const icon = useThemeColor("--color-icon");
  const activeTrack = String(useThemeColor("--color-switch-active"));
  const track = String(useThemeColor("--color-secondary-border"));

  return (
    <View
      className="flex-row items-center gap-4 p-4"
      style={{ opacity: props.disabled ? 0.45 : 1 }}
    >
      <SymbolView name={props.icon} size={22} tintColor={icon} type="monochrome" weight="regular" />
      <Text className="flex-1 text-[17px] text-foreground">{props.label}</Text>
      <Switch
        disabled={props.disabled}
        ios_backgroundColor={track}
        onValueChange={props.onValueChange}
        trackColor={{ false: track, true: activeTrack }}
        value={props.value}
      />
    </View>
  );
}
