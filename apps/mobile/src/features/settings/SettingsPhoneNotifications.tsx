import { useGT } from "gt-react-native";
import { useRef, useState } from "react";
import { Linking } from "react-native";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { runtime } from "../../lib/runtime";
import {
  openPhoneBatterySettings,
  phoneNotificationsEnabled,
  setPhoneNotificationsEnabled,
  supportsPhoneNotifications,
} from "../agent-awareness/androidNotifications";
import { requestAgentNotificationPermission } from "../agent-awareness/notificationPermissions";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsRow } from "./components/SettingsRow";

function batterySettings() {
  try {
    openPhoneBatterySettings();
  } catch {
    void Linking.openSettings();
  }
}

export function SettingsPhoneNotifications() {
  const gt = useGT();
  const [enabled, setEnabled] = useState(phoneNotificationsEnabled);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const available = supportsPhoneNotifications();

  async function applyToggle(next: boolean) {
    try {
      if (next) {
        const permission = await runtime.runPromise(requestAgentNotificationPermission);
        if (permission.type !== "granted") {
          Dialog.alert(
            gt("Notification permission needed"),
            gt("Allow notifications in Android Settings, then try again."),
            [
              { text: gt("Cancel"), style: "cancel" },
              { text: gt("Open Settings"), onPress: () => void Linking.openSettings() },
            ],
          );
          return;
        }
      }
      setPhoneNotificationsEnabled(next);
      setEnabled(next);
      if (next) {
        Dialog.alert(
          gt("Allow background connection?"),
          gt(
            "For timely notifications with the screen off, allow {product} to run without battery optimization. Your server and tailnet must remain reachable.",
            { product: "Dulli" },
          ),
          [
            { text: gt("Not now"), style: "cancel" },
            { text: gt("Battery settings"), onPress: batterySettings },
          ],
        );
      }
    } catch (error) {
      setEnabled(phoneNotificationsEnabled());
      Dialog.alert(
        gt("Couldn't update notifications"),
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  function toggle(next: boolean) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    // Promise.finally instead of try/finally: the React Compiler cannot lower a finally clause.
    void applyToggle(next).finally(() => {
      inFlight.current = false;
      setBusy(false);
    });
  }

  return (
    <SettingsScreen title={gt("Notifications")}>
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
      >
        <SettingsSection title={gt("Paired servers")}>
          <SettingsSwitchRow
            icon="bell.badge"
            label={gt("Background phone notifications")}
            subtitle={
              available
                ? gt(
                    "Stay connected to your own servers for approvals, questions and finished turns. Shows a persistent {product} connected notification.",
                    { product: "Dulli" },
                  )
                : gt("Install a newer {product} Android app to enable background notifications.", {
                    product: "Dulli",
                  })
            }
            value={enabled}
            disabled={!available || busy}
            onValueChange={toggle}
          />
          {enabled ? (
            <SettingsRow
              icon="bolt.circle"
              label={gt("Battery optimization")}
              onPress={batterySettings}
            />
          ) : null}
        </SettingsSection>
      </ScreenScrollView>
    </SettingsScreen>
  );
}
