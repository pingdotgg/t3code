import type { DesktopNotificationEvent, DesktopNotificationSettings } from "@t3tools/contracts";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import {
  getBrowserNotificationPermission,
  requestBrowserNotificationPermission,
  showBrowserNotificationTest,
  type BrowserNotificationPermission,
} from "../../browserNotifications.ts";
import { isElectron } from "../../env.ts";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings.ts";
import { cn } from "../../lib/utils.ts";
import { Button } from "../ui/button.tsx";
import { Switch } from "../ui/switch.tsx";
import { toastManager } from "../ui/toast.tsx";
import { SettingsRow, SettingsSection } from "./settingsLayout.tsx";
import { searchableSetting } from "./settingsSearch.ts";

const EVENT_OPTIONS: ReadonlyArray<{
  readonly event: DesktopNotificationEvent;
  readonly title: string;
  readonly description: string;
}> = [
  {
    event: "approval",
    title: "Approval needed",
    description: "An agent needs your approval.",
  },
  {
    event: "input",
    title: "Waiting for input",
    description: "An agent needs your input.",
  },
  {
    event: "completion",
    title: "Agent finished",
    description: "An agent finishes a turn.",
  },
  {
    event: "failure",
    title: "Agent failed",
    description: "An agent stops with an error.",
  },
];

function useBrowserNotificationPermission() {
  const [permission, setPermission] = useState<BrowserNotificationPermission>(() =>
    isElectron ? "granted" : getBrowserNotificationPermission(),
  );
  const refresh = useCallback(() => {
    setPermission(isElectron ? "granted" : getBrowserNotificationPermission());
  }, []);

  useEffect(() => {
    if (isElectron) return;

    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    let permissionStatus: PermissionStatus | undefined;
    let disposed = false;
    if (navigator.permissions !== undefined) {
      void navigator.permissions
        .query({ name: "notifications" })
        .then((status) => {
          if (disposed) return;
          permissionStatus = status;
          status.addEventListener("change", refresh);
        })
        .catch(() => undefined);
    }

    return () => {
      disposed = true;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      permissionStatus?.removeEventListener("change", refresh);
    };
  }, [refresh]);

  return { permission, refresh };
}

function useDesktopNotificationSettingsModel() {
  const settings = useClientSettings((current) => current.desktopNotifications);
  const updateClientSettings = useUpdateClientSettings();
  const browserPermission = useBrowserNotificationPermission();
  const update = (patch: Partial<DesktopNotificationSettings>) => {
    updateClientSettings((current) => ({
      desktopNotifications: { ...current.desktopNotifications, ...patch },
    }));
  };
  const updateEvent = (event: DesktopNotificationEvent, enabled: boolean) => {
    updateClientSettings((current) => ({
      desktopNotifications: {
        ...current.desktopNotifications,
        events: { ...current.desktopNotifications.events, [event]: enabled },
      },
    }));
  };
  const setEnabled = async (enabled: boolean) => {
    if (!enabled || isElectron) {
      update({ enabled });
      return;
    }

    const permission = await requestBrowserNotificationPermission();
    browserPermission.refresh();
    if (permission === "granted") {
      update({ enabled: true });
      return;
    }
    toastManager.add({
      type: "warning",
      title: permission === "unsupported" ? "Notifications unavailable" : "Permission required",
      description:
        permission === "denied"
          ? "Allow notifications in your browser settings."
          : permission === "unsupported"
            ? "This browser does not support notifications."
            : "Allow notifications, then try again.",
    });
  };
  const sendTest = async () => {
    const notifications = window.desktopBridge?.notifications;
    let result;
    if (notifications) {
      result = await notifications
        .showTest({ silent: !settings.soundEnabled })
        .catch(() => "failed" as const);
    } else {
      const permission = await requestBrowserNotificationPermission();
      browserPermission.refresh();
      result =
        permission === "granted"
          ? showBrowserNotificationTest({ silent: !settings.soundEnabled })
          : permission === "unsupported"
            ? "unsupported"
            : "suppressed";
    }
    if (result === "shown") {
      toastManager.add({
        type: "success",
        title: "Test sent",
        description: "Check Notification Center.",
      });
      return;
    }
    toastManager.add({
      type: "warning",
      title: "Notification unavailable",
      description:
        result === "unsupported"
          ? "Notifications are not supported here."
          : result === "suppressed"
            ? "Allow notifications, then try again."
            : "The notification could not be shown.",
    });
  };

  const masterDescription = isElectron
    ? "Notify me when T3 Code is in the background."
    : browserPermission.permission === "denied"
      ? "Blocked in your browser settings."
      : browserPermission.permission === "unsupported"
        ? "Not supported by this browser."
        : browserPermission.permission === "default"
          ? "Allow notifications when T3 Code is in the background."
          : "Notify me when T3 Code is in the background.";

  return {
    settings,
    update,
    updateEvent,
    setEnabled,
    sendTest,
    masterDescription,
    supported: isElectron || browserPermission.permission !== "unsupported",
  };
}

type NotificationSettingsModel = ReturnType<typeof useDesktopNotificationSettingsModel>;

function MasterRow({
  model,
  title = "Enable notifications",
  description,
}: {
  readonly model: NotificationSettingsModel;
  readonly title?: string;
  readonly description?: string;
}) {
  return (
    <SettingsRow
      title={title}
      description={description ?? model.masterDescription}
      control={
        <Switch
          checked={model.settings.enabled}
          disabled={!model.supported && !model.settings.enabled}
          onCheckedChange={(checked) => void model.setEnabled(Boolean(checked))}
          aria-label="Notifications"
        />
      }
    />
  );
}

function EnabledOptions({
  enabled,
  children,
}: {
  readonly enabled: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div
      inert={!enabled}
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
        enabled ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
    >
      <div className="overflow-hidden">{children}</div>
    </div>
  );
}

function SoftGroupedPanel({ model }: { readonly model: NotificationSettingsModel }) {
  return (
    <div className="rounded-2xl bg-muted/25">
      <div className="rounded-2xl bg-background/80">
        <MasterRow model={model} />
        <EnabledOptions enabled={model.settings.enabled}>
          <div className="border-t border-border/50 px-3 pt-3 pb-2 sm:px-4">
            <p className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Notify me when
            </p>
            {EVENT_OPTIONS.map((option) => (
              <label
                key={option.event}
                className="flex cursor-pointer items-center justify-between gap-4 rounded-lg py-2 hover:bg-muted/35"
              >
                <span>
                  <span className="block text-sm font-medium tracking-[-0.005em] text-foreground">
                    {option.title}
                  </span>
                  <span className="block text-[13px] leading-[1.45] text-muted-foreground/80">
                    {option.description}
                  </span>
                </span>
                <Switch
                  checked={model.settings.events[option.event]}
                  onCheckedChange={(checked) => model.updateEvent(option.event, Boolean(checked))}
                  aria-label={option.title}
                />
              </label>
            ))}
            <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2 border-t border-border/50 pt-3 pb-1">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <Switch
                  checked={model.settings.soundEnabled}
                  onCheckedChange={(checked) => model.update({ soundEnabled: Boolean(checked) })}
                  aria-label="Notification sound"
                />
                Play sound
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <Switch
                  checked={model.settings.showContext}
                  onCheckedChange={(checked) => model.update({ showContext: Boolean(checked) })}
                  aria-label="Show thread names"
                />
                Show thread names
              </label>
            </div>
          </div>
        </EnabledOptions>
      </div>
    </div>
  );
}

export function DesktopNotificationsSettings() {
  const model = useDesktopNotificationSettingsModel();

  return (
    <SettingsSection
      {...searchableSetting("desktop-notifications")}
      headerAction={
        <Button size="xs" variant="outline" onClick={() => void model.sendTest()}>
          Send test
        </Button>
      }
    >
      <SoftGroupedPanel model={model} />
    </SettingsSection>
  );
}
