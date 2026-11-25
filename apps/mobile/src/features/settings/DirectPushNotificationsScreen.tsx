import { useAtomValue } from "@effect/atom-react";
import { useState, useSyncExternalStore } from "react";
import { Linking } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { environmentPresentations } from "../../state/presentation";
import {
  directPushAvailable,
  getDirectPushState,
  setDirectPushEnabled,
  subscribeDirectPushState,
} from "../agent-awareness/directPushRegistration";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsScreen } from "./components/SettingsScreen";

/** Notifications for builds without T3 Connect: each environment pushes to Apple itself. */
export function DirectPushNotificationsScreen() {
  const insets = useSafeAreaInsets();
  const state = useSyncExternalStore(subscribeDirectPushState, getDirectPushState);
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const [busy, setBusy] = useState(false);

  if (!directPushAvailable()) {
    return (
      <SettingsScreen title="Notifications">
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="px-5 pt-4"
        >
          <Text className="text-base text-foreground-muted">
            This build can't receive push notifications.
          </Text>
        </ScrollView>
      </SettingsScreen>
    );
  }

  const connected = [...presentations].filter(
    ([, presentation]) => presentation.connection.phase === "connected",
  );
  const registered = new Set(state.registeredEnvironmentIds);
  const receiving = connected.filter(([id]) => registered.has(id));
  const unsupported = connected.filter(
    ([, presentation]) =>
      presentation.serverConfig !== null && presentation.serverConfig.directPush !== true,
  );
  const label = (entries: typeof connected) =>
    entries.map(([, presentation]) => presentation.entry.target.label).join(", ");

  const handleChange = async (next: boolean) => {
    setBusy(true);
    const result = await setDirectPushEnabled(next).catch(() => "failed" as const);
    setBusy(false);
    if (result === "blocked") {
      Dialog.alert(
        "Notifications disabled",
        "Notifications were denied for this app. Open Settings to enable them.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Open Settings", onPress: () => void Linking.openSettings() },
        ],
      );
    } else if (result === "denied") {
      Dialog.alert("Notifications disabled", "Notifications were not enabled.");
    } else if (result === "failed") {
      Dialog.alert("Notifications unavailable", "Could not change notification settings.");
    }
  };

  return (
    <SettingsScreen title="Notifications">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Agent activity">
          <SettingsSwitchRow
            icon="bell.badge"
            label="Device Notifications"
            disabled={busy || state.enabled === null}
            subtitle="Alerts when an agent finishes, fails, or needs approval or input."
            value={state.enabled === true}
            onValueChange={(next) => void handleChange(next)}
          />
        </SettingsSection>
        <Text className="text-sm text-foreground-muted">
          {state.enabled !== true
            ? "Each connected environment sends notifications itself once it has an Apple push key, set in its Settings → General → Notifications on desktop or web."
            : receiving.length > 0
              ? `Receiving notifications from ${label(receiving)}. An environment needs an Apple push key, set in its Settings → General → Notifications on desktop or web.`
              : "No connected environment has registered this device yet. An environment needs an Apple push key, set in its Settings → General → Notifications on desktop or web."}
          {unsupported.length > 0
            ? ` ${label(unsupported)} can't send notifications to this build.`
            : ""}
        </Text>
      </ScrollView>
    </SettingsScreen>
  );
}
