import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useState } from "react";
import { Alert, AppState, Linking, Platform, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import {
  addBackgroundConnectionStatusListener,
  getBackgroundConnectionStatus,
  requestBackgroundConnectionBatteryOptimizationExemption,
  setBackgroundConnectionEnabled,
  type BackgroundConnectionStatus,
} from "../../native/backgroundConnection";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import {
  backgroundConnectionStatusLabel,
  shouldRequestBackgroundConnectionBatteryExemption,
} from "./settings-model";
import {
  getAndroidAgentNotificationPermission,
  requestAndroidAgentNotificationPermission,
  type AndroidNotificationPermission,
} from "../agent-notifications/android-thread-notifications";

function promptForBatteryExemption(
  requestExemption: () => Promise<BackgroundConnectionStatus>,
): void {
  Alert.alert(
    "Allow unrestricted battery use?",
    "Android can otherwise pause the background connection while T3 Code is locked or another app is open.",
    [
      { text: "Not Now", style: "cancel" },
      { text: "Allow", onPress: () => void requestExemption() },
    ],
  );
}

export function BackgroundConnectionSettingsSection() {
  const [status, setStatus] = useState(getBackgroundConnectionStatus);
  const [changing, setChanging] = useState(false);
  const [notificationPermission, setNotificationPermission] =
    useState<AndroidNotificationPermission>({ type: "unsupported" });
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const notificationPreferenceEnabled =
    AsyncResult.isSuccess(preferencesResult) &&
    preferencesResult.value.androidAgentNotificationsEnabled === true;

  useEffect(() => {
    if (Platform.OS !== "android") {
      return;
    }
    setStatus(getBackgroundConnectionStatus());
    void getAndroidAgentNotificationPermission()
      .then(setNotificationPermission)
      .catch((error) => {
        console.error(
          "[agent-notifications] failed to read Android notification permission",
          error,
        );
        setNotificationPermission({ type: "denied", canAskAgain: true });
      });
    const nativeSubscription = addBackgroundConnectionStatusListener(setStatus);
    const appStateSubscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        setStatus(getBackgroundConnectionStatus());
        void getAndroidAgentNotificationPermission()
          .then(setNotificationPermission)
          .catch((error) => {
            console.error(
              "[agent-notifications] failed to refresh Android notification permission",
              error,
            );
          });
      }
    });
    return () => {
      nativeSubscription.remove();
      appStateSubscription.remove();
    };
  }, []);

  const requestExemption = useCallback(async () => {
    const next = await requestBackgroundConnectionBatteryOptimizationExemption();
    setStatus(next);
    return next;
  }, []);

  const handleEnabledChange = useCallback(
    async (enabled: boolean) => {
      if (changing) {
        return;
      }
      setChanging(true);
      setStatus((current) => ({ ...current, enabled }));
      const next = await setBackgroundConnectionEnabled(enabled);
      setStatus(next);
      setChanging(false);
      if (!enabled) {
        savePreferences({ androidAgentNotificationsEnabled: false });
      }
      if (shouldRequestBackgroundConnectionBatteryExemption(next)) {
        promptForBatteryExemption(requestExemption);
      }
    },
    [changing, requestExemption, savePreferences],
  );

  const handleNotificationsChange = useCallback(
    async (enabled: boolean) => {
      if (!enabled) {
        savePreferences({ androidAgentNotificationsEnabled: false });
        return;
      }
      setChanging(true);
      try {
        const permission = await requestAndroidAgentNotificationPermission();
        setNotificationPermission(permission);
        if (permission.type !== "granted") {
          savePreferences({ androidAgentNotificationsEnabled: false });
          if (permission.type === "denied" && !permission.canAskAgain) {
            Alert.alert(
              "Notifications disabled",
              "Notification access was denied for T3 Code. Open Android Settings to enable it.",
              [
                { text: "Cancel", style: "cancel" },
                { text: "Open Settings", onPress: () => void Linking.openSettings() },
              ],
            );
          }
          return;
        }
        savePreferences({ androidAgentNotificationsEnabled: true });
        if (!status.enabled) {
          const next = await setBackgroundConnectionEnabled(true);
          setStatus(next);
          if (shouldRequestBackgroundConnectionBatteryExemption(next)) {
            promptForBatteryExemption(requestExemption);
          }
        }
      } catch (error) {
        savePreferences({ androidAgentNotificationsEnabled: false });
        Alert.alert(
          "Notifications unavailable",
          error instanceof Error ? error.message : "Could not enable Android notifications.",
        );
      } finally {
        setChanging(false);
      }
    },
    [requestExemption, savePreferences, status.enabled],
  );

  if (Platform.OS !== "android") {
    return null;
  }

  const statusLabel = backgroundConnectionStatusLabel(status);
  const canRetryBatteryExemption = shouldRequestBackgroundConnectionBatteryExemption(status);

  return (
    <View className="gap-3">
      <SettingsSection title="Background connection">
        <SettingsSwitchRow
          disabled={!status.supported || changing}
          icon="bolt.horizontal.circle"
          label="Keep connected in background"
          value={status.enabled}
          onValueChange={(enabled) => void handleEnabledChange(enabled)}
        />
        <SettingsSwitchRow
          disabled={!status.supported || changing}
          icon="bell.badge"
          label="Agent notifications"
          value={
            status.enabled &&
            notificationPreferenceEnabled &&
            notificationPermission.type === "granted"
          }
          onValueChange={(enabled) => void handleNotificationsChange(enabled)}
        />
        <View className="border-t border-border px-4 py-3">
          {canRetryBatteryExemption ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => void requestExemption()}
              className="py-1"
            >
              <Text className="text-sm font-t3-medium text-foreground">{statusLabel}</Text>
              <Text className="mt-1 text-sm text-foreground-muted">
                Tap to allow unrestricted battery use.
              </Text>
            </Pressable>
          ) : (
            <Text className="text-sm font-t3-medium text-foreground-muted">{statusLabel}</Text>
          )}
        </View>
      </SettingsSection>
      <Text className="px-2 text-sm leading-normal text-foreground-muted">
        Keeps environments and active work synchronized while your phone is locked or another app is
        open. This can noticeably increase battery use, and Android will show a silent ongoing
        service status. Agent notifications alert you when work completes, fails, or needs your
        approval or input.
      </Text>
    </View>
  );
}
