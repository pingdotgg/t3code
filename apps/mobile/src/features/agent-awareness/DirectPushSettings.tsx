import { useGT } from "gt-react-native";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Alert, Linking, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { runtime } from "../../lib/runtime";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironments } from "../../state/environments";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { directPushDeliveryAtom, directPushStatusAtom } from "./DirectPushCoordinator";
import { describeDirectPushDelivery } from "./directRegistration";
import { supportsDirectPush } from "./capabilities";
import { requestAgentNotificationPermission } from "./notificationPermissions";

export function DirectPushSettings() {
  const gt = useGT();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomCommand(saveMobilePreferences);
  const statuses = useAtomValue(directPushStatusAtom);
  const deliveries = useAtomValue(directPushDeliveryAtom);
  const { environments } = useEnvironments();
  const [busy, setBusy] = useState(false);
  if (!supportsDirectPush()) return null;
  const loaded = AsyncResult.isSuccess(preferences);
  const enabled = loaded && preferences.value.directPushEnabled === true;
  const liveEnabled = loaded && preferences.value.directLiveActivitiesEnabled !== false;
  return (
    <SettingsSection title={gt("Apple notifications from my servers")}>
      <SettingsSwitchRow
        icon="bell.badge"
        label={gt("Use my servers")}
        value={enabled}
        disabled={!loaded || busy}
        subtitle={gt(
          "Receive input and approval alerts without a Cloud Connect account. Each server needs Apple notification setup.",
        )}
        onValueChange={(value) => {
          setBusy(true);
          void (async () => {
            if (value) {
              const permission = await runtime.runPromise(requestAgentNotificationPermission);
              if (permission.type === "denied") {
                Alert.alert(
                  gt("Notification permission needed"),
                  gt(
                    "Allow notifications in iOS Settings to hear input and approval alerts. Live Activities can still be enabled separately.",
                  ),
                  [
                    { text: gt("Cancel"), style: "cancel" },
                    { text: gt("Open Settings"), onPress: () => void Linking.openSettings() },
                  ],
                );
              }
            }
            const result = await save({ directPushEnabled: value });
            if (result._tag === "Failure") {
              Alert.alert(gt("Could not save notification settings"), gt("Try again."));
            }
          })()
            .catch(() =>
              Alert.alert(
                gt("Could not enable notifications"),
                gt("Check notification access in iOS Settings."),
              ),
            )
            .finally(() => setBusy(false));
        }}
      />
      <SettingsSwitchRow
        icon="bolt.circle"
        label={gt("Live Activities")}
        value={enabled && liveEnabled}
        disabled={!enabled}
        subtitle={gt(
          "Open the app while work is active to show it on the Lock Screen and Dynamic Island.",
        )}
        onValueChange={(value) => void save({ directLiveActivitiesEnabled: value })}
      />
      {enabled ? (
        <View className="gap-2 px-4 pb-4">
          {environments.map((environment) => {
            const delivery = deliveries.get(environment.environmentId);
            return (
              <View key={environment.environmentId} className="gap-0.5">
                <Text className="text-sm text-foreground-muted">
                  {environment.label}:{" "}
                  {statuses.get(environment.environmentId) ?? gt("Connect to register this device")}
                </Text>
                {delivery ? (
                  <Text className="text-sm text-foreground-muted">
                    {describeDirectPushDelivery(delivery)}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}
    </SettingsSection>
  );
}
