import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { DEFAULT_QUIET_HOURS, type QuietHours } from "@t3tools/contracts/settings";
import { useState } from "react";

import {
  hasDesktopNotifications,
  hasNotificationSound,
  NOTIFICATION_MODE_LABELS,
  unlockNotificationAudio,
} from "../../threadNotifications";
import { Switch } from "../ui/switch";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

function formatQuietMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

function parseQuietTime(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(mins)) return null;
  if (hours < 0 || hours > 23 || mins < 0 || mins > 59) return null;
  return hours * 60 + mins;
}

export function NotificationSettings() {
  const mode = useScopedSettings((settings) => settings.notificationMode);
  const quietHours = useScopedSettings((settings) => settings.quietHours ?? DEFAULT_QUIET_HOURS);
  const updateSettings = useUpdateScopedSettings();
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  const patchQuietHours = (patch: Partial<QuietHours>) => {
    updateSettings({ quietHours: { ...quietHours, ...patch } });
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("thread-notifications")}
        description={
          permissionMessage ??
          "System alerts when a thread finishes, fails, or needs input or approval. Applies to this device while T3 Code is open."
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
                    "Notifications need a supported browser over HTTPS, or the desktop app. Sound only is still available.",
                  );
                  return;
                }
                setRequesting(true);
                const permission = await settlePromise(() => Notification.requestPermission());
                setRequesting(false);
                if (permission._tag === "Failure") {
                  setPermissionMessage(
                    "Notifications are unavailable in this browser. Sound only is still available.",
                  );
                  return;
                }
                if (permission.value !== "granted") {
                  setPermissionMessage(
                    "Allow notifications in your browser or system settings, then choose this option again. Sound only is still available.",
                  );
                  return;
                }
              }
              updateSettings({ notificationMode: value });
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Thread notifications">
              <SelectValue>{NOTIFICATION_MODE_LABELS[mode]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {Object.entries(NOTIFICATION_MODE_LABELS).map(([value, label]) => (
                <SelectItem key={value} hideIndicator value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...searchableSetting("quiet-hours")}
        description="Defer routine desktop and sound alerts during this local window. In-thread approval and review cards still show."
        control={
          <div className="flex w-full flex-col items-end gap-2 sm:w-auto">
            <Switch
              checked={quietHours.enabled}
              aria-label="Quiet hours"
              onCheckedChange={(enabled) => patchQuietHours({ enabled })}
            />
            {quietHours.enabled ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="time"
                  aria-label="Quiet hours start"
                  className="rounded-md border border-border bg-transparent px-2 py-1"
                  value={formatQuietMinutes(quietHours.startMinutes)}
                  onChange={(event) => {
                    const startMinutes = parseQuietTime(event.target.value);
                    if (startMinutes === null) return;
                    patchQuietHours({ startMinutes });
                  }}
                />
                <span>to</span>
                <input
                  type="time"
                  aria-label="Quiet hours end"
                  className="rounded-md border border-border bg-transparent px-2 py-1"
                  value={formatQuietMinutes(quietHours.endMinutes)}
                  onChange={(event) => {
                    const endMinutes = parseQuietTime(event.target.value);
                    if (endMinutes === null) return;
                    patchQuietHours({ endMinutes });
                  }}
                />
              </div>
            ) : null}
          </div>
        }
      />
    </>
  );
}
