import { useAtomValue } from "@effect/atom-react";
import * as Notifications from "expo-notifications";
import { AsyncResult } from "effect/reactivity";
import { msg, useGT } from "gt-react-native";
import { Platform, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { KompasPage } from "./KompasPage";
import { kompasEnvironment, reportFailure } from "./state";

const REMINDER_ID = "kompas-study-reminder";
const REMINDER_CHANNEL = "study-reminder";
const DEFAULT_HOUR = 18;

/** Replaces the daily reminder, or only clears it when `hour` is null; false without permission. */
async function scheduleReminder(hour: number | null): Promise<boolean> {
  await Notifications.cancelScheduledNotificationAsync(REMINDER_ID);
  if (hour === null) return true;
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(REMINDER_CHANNEL, {
      name: m(msg("Study reminder")),
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }
  const { granted } = await Notifications.requestPermissionsAsync();
  if (!granted) return false;
  await Notifications.scheduleNotificationAsync({
    identifier: REMINDER_ID,
    content: {
      title: m(msg("Time to review")),
      body: m(msg("A few minutes with your flashcards keeps them fresh.")),
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DAILY,
      hour,
      minute: 0,
      channelId: REMINDER_CHANNEL,
    },
  });
  return true;
}

export function KompasSettingsScreen() {
  const gt = useGT();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const updateSettings = useAtomCommand(kompasEnvironment.updateSettings, { reportFailure: false });
  const hour = AsyncResult.isSuccess(preferences)
    ? (preferences.value.studyReminderHour ?? null)
    : null;
  const setHour = async (next: number | null) => {
    try {
      if (await scheduleReminder(next)) {
        await savePreferences({ studyReminderHour: next });
        return;
      }
      Dialog.alert(
        gt("Notifications are off"),
        gt("Allow them for Kompas in the system settings, then try again."),
      );
    } catch (error) {
      Dialog.alert(
        gt("Could not set the reminder"),
        error instanceof Error ? error.message : undefined,
      );
    }
  };
  return (
    <KompasPage title={gt("Mode and reminders")}>
      {({ environmentId, snapshot }) => (
        <>
          <SettingsSection title={gt("Study")}>
            <SettingsSwitchRow
              label={gt("Daily study reminder")}
              subtitle={gt("A notification from this phone, at the hour you pick.")}
              value={hour !== null}
              onValueChange={(on) => void setHour(on ? DEFAULT_HOUR : null)}
            />
            {hour === null ? null : (
              <View className="flex-row items-center gap-3 bg-grouped-card px-4 py-3">
                <Button
                  size="compact"
                  label={gt("Earlier")}
                  onPress={() => void setHour((hour + 23) % 24)}
                />
                <Text className="flex-1 text-center font-t3-bold text-lg">
                  {`${String(hour).padStart(2, "0")}:00`}
                </Text>
                <Button
                  size="compact"
                  label={gt("Later")}
                  onPress={() => void setHour((hour + 1) % 24)}
                />
              </View>
            )}
          </SettingsSection>
          <SettingsSection title={gt("Mode")}>
            <SettingsSwitchRow
              label={gt("Developer mode")}
              subtitle={gt(
                "Show the coding tools: projects on disk, branches, diffs, terminal and pull requests.",
              )}
              value={snapshot.settings.developerMode}
              onValueChange={(developerMode) =>
                void updateSettings({ environmentId, input: { developerMode } }).then(reportFailure)
              }
            />
          </SettingsSection>
        </>
      )}
    </KompasPage>
  );
}
