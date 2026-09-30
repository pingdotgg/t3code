import { translate } from "@t3tools/i18n";
import { useTranslation } from "@t3tools/i18n/react";
import { useState } from "react";

import {
  hasDesktopNotifications,
  hasNotificationSound,
  NOTIFICATION_MODE_LABELS,
  unlockNotificationAudio,
} from "../../threadNotifications";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const NOTIFICATION_MODE_LABEL_KEYS = {
  off: "uiThreadNotificationModeOff",
  notifications: "uiThreadNotificationModeNotificationsOnly",
  sound: "uiThreadNotificationModeSoundOnly",
  "notifications-and-sound": "uiThreadNotificationModeNotificationsWithSound",
} as const;

export function NotificationSettings() {
  const { t } = useTranslation("common");
  const mode = useScopedSettings((settings) => settings.notificationMode);
  const updateSettings = useUpdateScopedSettings();
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  return (
    <SettingsRow
      {...searchableSetting("thread-notifications")}
      description={
        permissionMessage ??
        translate(
          "common:uiThreadNotificationDescription",
          "System alerts when a thread finishes, fails, or needs input or approval. Applies to this device while T3 Code is open.",
        )
      }
      control={
        <Select
          value={mode}
          disabled={requesting}
          onValueChange={async (value) => {
            if (
              value !== "off" &&
              value !== "notifications" &&
              value !== "sound" &&
              value !== "notifications-and-sound"
            )
              return;
            setPermissionMessage(null);
            if (hasNotificationSound(value)) unlockNotificationAudio();
            if (hasDesktopNotifications(value)) {
              if (typeof Notification === "undefined" || !window.isSecureContext) {
                setPermissionMessage(
                  translate(
                    "common:uiThreadNotificationsNeedHttps",
                    "Notifications need a supported browser over HTTPS or the desktop app. Sound only is still available.",
                  ),
                );
                return;
              }
              setRequesting(true);
              try {
                const permission = await Notification.requestPermission();
                if (permission !== "granted") {
                  setPermissionMessage(
                    translate(
                      "common:uiAllowNotificationsInSystemSettings",
                      "Allow notifications in your browser or system settings, then choose this option again. Sound only is still available.",
                    ),
                  );
                  return;
                }
              } catch {
                setPermissionMessage(
                  translate(
                    "common:uiNotificationsUnavailableInBrowser",
                    "Notifications are unavailable in this browser. Sound only is still available.",
                  ),
                );
                return;
              } finally {
                setRequesting(false);
              }
            }
            updateSettings({ notificationMode: value });
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-56"
            aria-label={translate("common:uiThreadNotifications", "Thread notifications")}
          >
            <SelectValue>
              {t(NOTIFICATION_MODE_LABEL_KEYS[mode], {
                defaultValue: NOTIFICATION_MODE_LABELS[mode],
              })}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Object.entries(NOTIFICATION_MODE_LABELS).map(([value, label]) => (
              <SelectItem key={value} hideIndicator value={value}>
                {t(
                  NOTIFICATION_MODE_LABEL_KEYS[value as keyof typeof NOTIFICATION_MODE_LABEL_KEYS],
                  {
                    defaultValue: label,
                  },
                )}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
