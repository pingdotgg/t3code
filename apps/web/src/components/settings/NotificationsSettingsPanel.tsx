import { BellIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { useState } from "react";

import { isElectron } from "~/env";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import {
  disableWebPushNotifications,
  enableWebPushNotifications,
  isWebPushSupported,
} from "~/notifications/webPush";
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
    description: "Play an alert sound.",
    resetLabel: "notification sound",
  },
];

export function NotificationsSettingsPanel() {
  const settings = useClientSettings();
  const updateSettings = useUpdateClientSettings();
  const relaySession = useAtomValue(managedRelaySessionAtom);
  const [webPushError, setWebPushError] = useState<string | null>(null);
  const [webPushPending, setWebPushPending] = useState(false);
  const enabledKey = isElectron
    ? ("desktopNotificationsEnabled" as const)
    : ("webPushNotificationsEnabled" as const);
  const notificationsEnabled = settings[enabledKey];
  const notificationsDisabled = isElectron && !notificationsEnabled;
  const webPushAvailable = isWebPushSupported() && relaySession !== null;

  const setNotificationsEnabled = async (checked: boolean) => {
    if (isElectron) {
      updateSettings({ desktopNotificationsEnabled: checked });
      return;
    }
    setWebPushPending(true);
    setWebPushError(null);
    try {
      if (checked) {
        await enableWebPushNotifications({
          ...settings,
          webPushNotificationsEnabled: true,
        });
      } else {
        await disableWebPushNotifications();
      }
      updateSettings({ webPushNotificationsEnabled: checked });
    } catch (error) {
      setWebPushError(error instanceof Error ? error.message : "Web Push setup failed.");
    } finally {
      setWebPushPending(false);
    }
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="Notifications" icon={<BellIcon className="size-4" />}>
        <SettingsRow
          {...searchableSetting("notifications")}
          title={isElectron ? "Notifications" : "Web Push"}
          description={
            webPushError ??
            (!isElectron && !webPushAvailable
              ? "Sign in to T3 Connect to enable Web Push."
              : "Notify when an agent needs you. Suppressed while you are looking at that thread.")
          }
          resetAction={
            notificationsEnabled !== DEFAULT_CLIENT_SETTINGS[enabledKey] ? (
              <SettingResetButton
                label="notifications"
                onClick={() => void setNotificationsEnabled(DEFAULT_CLIENT_SETTINGS[enabledKey])}
              />
            ) : null
          }
          control={
            <Switch
              checked={notificationsEnabled}
              disabled={webPushPending || (!isElectron && !webPushAvailable)}
              onCheckedChange={(checked) => void setNotificationsEnabled(Boolean(checked))}
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
