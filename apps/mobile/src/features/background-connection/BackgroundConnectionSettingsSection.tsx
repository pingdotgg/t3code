import { useCallback, useEffect, useState } from "react";
import { Alert, AppState, Platform, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
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

  useEffect(() => {
    if (Platform.OS !== "android") {
      return;
    }
    setStatus(getBackgroundConnectionStatus());
    const nativeSubscription = addBackgroundConnectionStatusListener(setStatus);
    const appStateSubscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        setStatus(getBackgroundConnectionStatus());
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
      if (shouldRequestBackgroundConnectionBatteryExemption(next)) {
        promptForBatteryExemption(requestExemption);
      }
    },
    [changing, requestExemption],
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
        service status.
      </Text>
    </View>
  );
}
