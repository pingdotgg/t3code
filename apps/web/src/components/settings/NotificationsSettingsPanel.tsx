import { useCallback, useSyncExternalStore } from "react";

import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { NotificationsSettingsIcon } from "../icons/custom";
import { Switch } from "../ui/switch";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

type DesktopThreadAttentionBridge = {
  notifyThreadAttention?: unknown;
};

function hasDesktopNotificationBridge(): boolean {
  if (typeof window === "undefined") return false;
  const bridge = (window as { desktopBridge?: DesktopThreadAttentionBridge }).desktopBridge;
  return typeof bridge?.notifyThreadAttention === "function";
}

function hasBrowserNotificationSupport(): boolean {
  return typeof Notification !== "undefined";
}

const permissionListeners = new Set<() => void>();

function subscribeNotificationPermission(listener: () => void): () => void {
  permissionListeners.add(listener);
  return () => {
    permissionListeners.delete(listener);
  };
}

function emitNotificationPermissionChange(): void {
  for (const listener of permissionListeners) {
    listener();
  }
}

function readNotificationPermission(): NotificationPermission | "unsupported" {
  return hasBrowserNotificationSupport() ? Notification.permission : "unsupported";
}

function useBrowserNotificationPermission(): NotificationPermission | "unsupported" {
  return useSyncExternalStore(subscribeNotificationPermission, readNotificationPermission);
}

export function NotificationsSettingsPanel() {
  const settings = useClientSettings();
  const updateClientSettings = useUpdateClientSettings();
  const usesDesktopBridge = hasDesktopNotificationBridge();
  const browserPermission = useBrowserNotificationPermission();
  const notificationsAvailable = usesDesktopBridge || browserPermission !== "unsupported";

  const requestBrowserPermissionIfNeeded = useCallback(() => {
    if (usesDesktopBridge || !hasBrowserNotificationSupport()) return;
    if (Notification.permission !== "default") return;
    void Notification.requestPermission()
      .catch(() => undefined)
      .finally(() => {
        emitNotificationPermissionChange();
      });
  }, [usesDesktopBridge]);

  if (!notificationsAvailable) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Thread attention">
          <Empty className="min-h-88">
            <EmptyMedia variant="icon">
              <NotificationsSettingsIcon className="size-4.5" />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>Notifications unavailable</EmptyTitle>
              <EmptyDescription>
                This browser does not support notifications. Open Forma in a supported browser or
                the desktop app to receive attention notifications for approval requests and
                question prompts.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  const permissionStatus =
    !usesDesktopBridge && browserPermission === "denied" ? (
      <span className="text-destructive">
        Browser notifications are blocked. Allow notifications for this site in your browser
        settings.
      </span>
    ) : null;

  return (
    <SettingsPageContainer>
      <SettingsSection title="Thread attention">
        <SettingsRow
          title="Approval requests"
          description="Notify when an agent needs permission to continue while Forma is not focused."
          status={permissionStatus}
          resetAction={
            settings.desktopNotifyOnApprovalRequests !==
            DEFAULT_UNIFIED_SETTINGS.desktopNotifyOnApprovalRequests ? (
              <SettingResetButton
                label="approval request notifications"
                onClick={() =>
                  updateClientSettings({
                    desktopNotifyOnApprovalRequests:
                      DEFAULT_UNIFIED_SETTINGS.desktopNotifyOnApprovalRequests,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.desktopNotifyOnApprovalRequests}
              onCheckedChange={(checked) => {
                if (checked) {
                  requestBrowserPermissionIfNeeded();
                }
                updateClientSettings({ desktopNotifyOnApprovalRequests: Boolean(checked) });
              }}
              aria-label="Approval request notifications"
            />
          }
        />

        <SettingsRow
          title="Question prompts"
          description="Notify when an agent asks you for input to continue while Forma is not focused."
          status={permissionStatus}
          resetAction={
            settings.desktopNotifyOnUserInputRequests !==
            DEFAULT_UNIFIED_SETTINGS.desktopNotifyOnUserInputRequests ? (
              <SettingResetButton
                label="question prompt notifications"
                onClick={() =>
                  updateClientSettings({
                    desktopNotifyOnUserInputRequests:
                      DEFAULT_UNIFIED_SETTINGS.desktopNotifyOnUserInputRequests,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.desktopNotifyOnUserInputRequests}
              onCheckedChange={(checked) => {
                if (checked) {
                  requestBrowserPermissionIfNeeded();
                }
                updateClientSettings({ desktopNotifyOnUserInputRequests: Boolean(checked) });
              }}
              aria-label="Question prompt notifications"
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
