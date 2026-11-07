import type { MessageKey } from "@t3tools/client-runtime/i18n";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { NotificationMode } from "@t3tools/contracts/settings";
import { useState } from "react";

import {
  hasDesktopNotifications,
  hasNotificationSound,
  unlockNotificationAudio,
} from "../../threadNotifications";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useT } from "../../hooks/useI18n";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const NOTIFICATION_MODE_LABELS: Record<NotificationMode, MessageKey> = {
  off: "settings.general.threadNotifications.mode.off",
  notifications: "settings.general.threadNotifications.mode.notifications",
  sound: "settings.general.threadNotifications.mode.sound",
  "notifications-and-sound": "settings.general.threadNotifications.mode.notificationsAndSound",
};

export function NotificationSettings() {
  const t = useT();
  const mode = useScopedSettings((settings) => settings.notificationMode);
  const updateSettings = useUpdateScopedSettings();
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  return (
    <SettingsRow
      {...searchableSetting("thread-notifications")}
      title={t("settings.general.threadNotifications.title")}
      description={permissionMessage ?? t("settings.general.threadNotifications.description")}
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
                setPermissionMessage(t("settings.general.threadNotifications.unsupported"));
                return;
              }
              setRequesting(true);
              const permission = await settlePromise(() => Notification.requestPermission());
              setRequesting(false);
              if (permission._tag === "Failure") {
                setPermissionMessage(t("settings.general.threadNotifications.unavailable"));
                return;
              }
              if (permission.value !== "granted") {
                setPermissionMessage(t("settings.general.threadNotifications.denied"));
                return;
              }
            }
            updateSettings({ notificationMode: value });
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-56"
            aria-label={t("settings.general.threadNotifications.a11y")}
          >
            <SelectValue>{t(NOTIFICATION_MODE_LABELS[mode])}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Object.entries(NOTIFICATION_MODE_LABELS).map(([value, label]) => (
              <SelectItem key={value} hideIndicator value={value}>
                {t(label)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
