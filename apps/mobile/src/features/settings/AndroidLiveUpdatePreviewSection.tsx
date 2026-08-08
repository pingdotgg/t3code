import * as Notifications from "expo-notifications";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import {
  cancelAndroidLiveUpdateMock,
  ensureAndroidLiveUpdateChannel,
  getAndroidLiveUpdateStatus,
  hasAndroidLiveUpdateModule,
  openAndroidLiveUpdatePromotionSettings,
  showAndroidLiveUpdateMock,
  type AndroidLiveUpdateMockKind,
  type AndroidLiveUpdateStatus,
} from "../agent-awareness/androidLiveUpdate";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";

export function AndroidLiveUpdatePreviewSection() {
  const [status, setStatus] = useState<AndroidLiveUpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const moduleAvailable = hasAndroidLiveUpdateModule();

  const refreshStatus = useCallback(async () => {
    const nextStatus = await getAndroidLiveUpdateStatus();
    setStatus(nextStatus);
  }, []);

  useEffect(() => {
    void refreshStatus();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshStatus();
    });
    return () => subscription.remove();
  }, [refreshStatus]);

  const run = useCallback(async (operation: () => Promise<AndroidLiveUpdateStatus>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      setStatus(await operation());
    } catch (cause) {
      Alert.alert(
        "Live Update preview unavailable",
        cause instanceof Error ? cause.message : "Could not update the mock notification.",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const showMock = useCallback(
    (kind: AndroidLiveUpdateMockKind) => {
      void run(async () => {
        await ensureAndroidLiveUpdateChannel();
        const currentPermission = await Notifications.getPermissionsAsync();
        const permission = currentPermission.granted
          ? currentPermission
          : await Notifications.requestPermissionsAsync();
        if (!permission.granted) {
          throw new Error("Allow notifications to display the Android Live Update preview.");
        }
        return showAndroidLiveUpdateMock(kind);
      });
    },
    [run],
  );

  const statusLabel = useMemo(
    () => formatStatus(status, moduleAvailable),
    [moduleAvailable, status],
  );
  const settingsValue = status?.canPostPromotedNotifications ? "Allowed" : "Review";

  return (
    <View className="gap-3">
      <SettingsSection title="Android Live Update · Mock">
        <SettingsRow
          disabled={busy || !moduleAvailable}
          icon="bolt.circle"
          label="Show Active Agents"
          onPress={() => showMock("working")}
        />
        <SettingsRow
          disabled={busy || !moduleAvailable}
          icon="exclamationmark.triangle"
          label="Show Needs Attention"
          onPress={() => showMock("attention")}
        />
        <SettingsRow
          disabled={busy || !moduleAvailable || !status?.active}
          icon="stop.fill"
          label="End Mock Update"
          onPress={() => void run(cancelAndroidLiveUpdateMock)}
        />
        <SettingsRow
          disabled={busy || !moduleAvailable}
          icon="gearshape"
          label="Promotion Settings"
          value={settingsValue}
          onPress={() => void run(openAndroidLiveUpdatePromotionSettings)}
        />
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        {statusLabel} Mock data only; relay and FCM delivery are intentionally deferred.
      </Text>
    </View>
  );
}

function formatStatus(status: AndroidLiveUpdateStatus | null, moduleAvailable: boolean): string {
  if (!moduleAvailable) return "Rebuild the Android development client to enable this preview.";
  if (!status) return "Checking Android notification capabilities.";
  if (!status.notificationsEnabled) return "Notification access is currently disabled.";
  if (status.active && status.promoted) return "A promoted Live Update is active.";
  if (status.active && status.promotable) {
    return status.canPostPromotedNotifications
      ? "A promotable ongoing notification is active."
      : "The ongoing notification is active, but promotion access is disabled.";
  }
  if (!status.supportsPromotion) {
    return "This device will use the standard ongoing-notification fallback.";
  }
  return status.canPostPromotedNotifications
    ? "This device allows promoted Live Updates."
    : "Open Promotion Settings to allow promoted Live Updates.";
}
