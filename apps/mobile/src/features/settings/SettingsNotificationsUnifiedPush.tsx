import { useGT } from "gt-react-native";
import { useSyncExternalStore } from "react";
import { Linking } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { runtime } from "../../lib/runtime";
import { settleAsyncResult } from "@t3tools/client-runtime/state/runtime";
import { requestAgentNotificationPermission } from "../agent-awareness/notificationPermissions";
import {
  disableUnifiedPush,
  enableUnifiedPush,
  getUnifiedPushState,
  subscribeUnifiedPushState,
} from "../agent-awareness/unifiedPush";
import { unifiedPushStatus } from "../agent-awareness/unifiedPush.logic";
import { unregisterUnifiedPushEverywhere } from "../agent-awareness/UnifiedPushRegistrar";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

export function SettingsNotificationsUnifiedPush() {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const state = useSyncExternalStore(subscribeUnifiedPushState, getUnifiedPushState, () => null);
  const status = unifiedPushStatus(state);

  const subtitle = {
    off: undefined,
    "no-distributor": gt("Install a UnifiedPush distributor such as ntfy first"),
    waiting: gt("Waiting for the distributor"),
    failed: gt("The distributor refused the registration"),
    ready: gt("Notifications arrive through {distributor}", {
      distributor: state?.distributor ?? "UnifiedPush",
    }),
  }[status];

  const enable = async () => {
    const permission = await settleAsyncResult(() =>
      runtime.runPromiseExit(requestAgentNotificationPermission),
    );
    if (permission._tag === "Failure" || permission.value.type !== "granted") {
      Dialog.alert(
        gt("Notifications disabled"),
        gt("Notifications were denied for this app. Open Settings to enable them."),
        [
          { text: gt("Cancel"), style: "cancel" },
          { text: gt("Open Settings"), onPress: () => void Linking.openSettings() },
        ],
      );
      return;
    }
    if ((await enableUnifiedPush()) === "none") {
      Dialog.alert(
        gt("No UnifiedPush distributor"),
        gt("Install a UnifiedPush distributor such as ntfy, then turn notifications on again."),
      );
    }
  };

  const disable = async () => {
    // Tell the servers first: disabling clears the device id they push to.
    const deviceId = state?.deviceId;
    if (deviceId) {
      await settleAsyncResult(() =>
        runtime.runPromiseExit(unregisterUnifiedPushEverywhere(deviceId)),
      );
    }
    disableUnifiedPush();
  };

  return (
    <SettingsScreen title={gt("Notifications")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title={gt("Agent activity")}>
          <SettingsSwitchRow
            icon="bell.badge"
            label={gt("Device Notifications")}
            subtitle={subtitle}
            value={state?.enabled === true}
            onValueChange={(enabled) => {
              if (enabled) void enable();
              else void disable();
            }}
          />
          {state?.lastMessageAt ? (
            <SettingsRow
              icon="clock"
              label={gt("Last notification")}
              value={new Date(state.lastMessageAt).toLocaleString()}
              valuePosition="below"
            />
          ) : null}
        </SettingsSection>
      </ScrollView>
    </SettingsScreen>
  );
}
