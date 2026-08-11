import { BellIcon } from "lucide-react";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";

import { isElectron } from "~/env";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { Switch } from "../ui/switch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting, type SettingsSearchItemId } from "./settingsSearch";

type NotificationToggleKey = Extract<
  keyof ClientSettings,
  | "desktopNotifyTaskCompleted"
  | "desktopNotifyTaskFailed"
  | "desktopNotifyApprovalNeeded"
  | "desktopNotificationSound"
>;

const NOTIFICATION_TOGGLES: ReadonlyArray<{
  readonly key: NotificationToggleKey;
  readonly searchId: SettingsSearchItemId;
  readonly description: string;
  readonly resetLabel: string;
}> = [
  {
    key: "desktopNotifyTaskCompleted",
    searchId: "notification-task-completed",
    description: "The agent finished its turn.",
    resetLabel: "task completed notifications",
  },
  {
    key: "desktopNotifyTaskFailed",
    searchId: "notification-task-failed",
    description: "The agent stopped with an error.",
    resetLabel: "task failed notifications",
  },
  {
    key: "desktopNotifyApprovalNeeded",
    searchId: "notification-approval-needed",
    description: "The agent is blocked until you approve an action.",
    resetLabel: "approval notifications",
  },
  {
    key: "desktopNotificationSound",
    searchId: "notification-sound",
    description: "Play the system notification sound.",
    resetLabel: "notification sound",
  },
];

export function NotificationsSettingsPanel() {
  const settings = useClientSettings();
  const updateSettings = useUpdateClientSettings();

  if (!isElectron) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Notifications" icon={<BellIcon className="size-4" />}>
          <p className="px-3 text-[13px] text-muted-foreground/80 sm:px-4">
            Native notifications are available in the desktop app.
          </p>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  const notificationsDisabled = !settings.desktopNotificationsEnabled;

  return (
    <SettingsPageContainer>
      <SettingsSection title="Notifications" icon={<BellIcon className="size-4" />}>
        <SettingsRow
          {...searchableSetting("notifications")}
          description="Show a native notification when an agent needs you. Suppressed while you are looking at that thread."
          resetAction={
            settings.desktopNotificationsEnabled !==
            DEFAULT_CLIENT_SETTINGS.desktopNotificationsEnabled ? (
              <SettingResetButton
                label="notifications"
                onClick={() =>
                  updateSettings({
                    desktopNotificationsEnabled:
                      DEFAULT_CLIENT_SETTINGS.desktopNotificationsEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.desktopNotificationsEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ desktopNotificationsEnabled: Boolean(checked) })
              }
              aria-label="Enable notifications"
            />
          }
        />

        {NOTIFICATION_TOGGLES.map((toggle) => (
          <SettingsRow
            key={toggle.key}
            {...searchableSetting(toggle.searchId)}
            description={toggle.description}
            resetAction={
              settings[toggle.key] !== DEFAULT_CLIENT_SETTINGS[toggle.key] ? (
                <SettingResetButton
                  label={toggle.resetLabel}
                  disabled={notificationsDisabled}
                  onClick={() =>
                    updateSettings({ [toggle.key]: DEFAULT_CLIENT_SETTINGS[toggle.key] })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings[toggle.key]}
                disabled={notificationsDisabled}
                onCheckedChange={(checked) => updateSettings({ [toggle.key]: Boolean(checked) })}
                aria-label={searchableSetting(toggle.searchId).title}
              />
            }
          />
        ))}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
