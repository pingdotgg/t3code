import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { Linking, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  notificationPermissionAtom,
  requestNotificationPermission,
} from "../notifications/notificationPermission";
import type { NotificationPermission } from "../notifications/pushRegistrationAction";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

const PERMISSION_VALUE: Record<NotificationPermission, string> = {
  checking: "Checking…",
  granted: "On",
  ask: "Not set up",
  denied: "Off in iOS Settings",
};

function environmentReason(
  environment: EnvironmentPresentation,
  connected: boolean,
  permission: NotificationPermission,
): string | null {
  // A disconnected server's cached config may predate push, so it can't say "update".
  if (!connected || environment.serverConfig === null) {
    return "Connect to this server to change this";
  }
  if (environment.serverConfig.environment.capabilities.pushNotifications !== true) {
    return "Update this server to get notifications";
  }
  if (permission !== "granted") return "Allow notifications above first";
  return null;
}

function PermissionSection() {
  const permission = useAtomValue(notificationPermissionAtom);
  const setPermission = useAtomSet(notificationPermissionAtom);
  const onPress = () => {
    if (permission === "ask") void requestNotificationPermission().then(setPermission);
    else void Linking.openSettings();
  };
  return (
    <SettingsSection
      title="This device"
      footer="Servers notify you when a thread needs your input or approval, finishes, or fails."
    >
      <SettingsRow
        icon="bell.badge"
        label={permission === "ask" ? "Turn on notifications" : "Notifications"}
        value={PERMISSION_VALUE[permission]}
        disabled={permission === "checking"}
        onPress={onPress}
      />
    </SettingsSection>
  );
}

export function SettingsNotificationsRouteScreen() {
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const permission = useAtomValue(notificationPermissionAtom);
  const connectedIds = useAtomValue(connectedEnvironmentIdsAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const ios = Platform.OS === "ios";
  const off = new Set(
    AsyncResult.isSuccess(preferences)
      ? (preferences.value.pushNotificationsOffEnvironmentIds ?? [])
      : [],
  );

  const setEnabled = (environmentId: EnvironmentId, enabled: boolean) =>
    savePreferences({
      transform: (current) => {
        const rest = (current.pushNotificationsOffEnvironmentIds ?? []).filter(
          (id) => id !== environmentId,
        );
        return { pushNotificationsOffEnvironmentIds: enabled ? rest : [...rest, environmentId] };
      },
    });

  return (
    <SettingsScreen title="Notifications">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {ios ? (
          <PermissionSection />
        ) : (
          <Text className="px-2 text-base text-foreground-muted">
            Push notifications are not available on Android yet.
          </Text>
        )}
        <SettingsSection title="Servers">
          {environments.length === 0 ? (
            <Text className="px-2 py-3 text-base text-foreground-muted">
              Pair a server to get notifications from it.
            </Text>
          ) : (
            environments.map((environment) => {
              const reason = ios
                ? environmentReason(
                    environment,
                    connectedIds.includes(environment.environmentId),
                    permission,
                  )
                : "Not available on Android yet";
              return (
                <SettingsSwitchRow
                  key={environment.environmentId}
                  icon="server.rack"
                  label={environment.label}
                  subtitle={reason ?? undefined}
                  disabled={reason !== null || !AsyncResult.isSuccess(preferences)}
                  // Off until it can actually notify, so a disabled switch never reads as on.
                  value={reason === null && !off.has(environment.environmentId)}
                  onValueChange={(enabled) => setEnabled(environment.environmentId, enabled)}
                />
              );
            })
          )}
        </SettingsSection>
      </ScrollView>
    </SettingsScreen>
  );
}
