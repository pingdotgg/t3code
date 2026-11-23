import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { useGT } from "gt-react";
import { useState } from "react";

import { m } from "~/i18n/messages";
import {
  desktopBackgroundServiceStateAtom,
  getDesktopBackgroundServiceBridge,
  refreshDesktopBackgroundServiceState,
} from "~/state/desktopBackgroundService";
import { useEnvironmentQuery } from "~/state/query";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

export function BackgroundServiceSetting() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const bridge = getDesktopBackgroundServiceBridge();
  const query = useEnvironmentQuery(bridge ? desktopBackgroundServiceStateAtom : null);
  const [pendingChecked, setPendingChecked] = useState<boolean | null>(null);

  const state = query.data;
  if (!bridge || !state?.supported) return null;

  const enabled = pendingChecked ?? state.enabled;
  const isUpdating = pendingChecked !== null;
  const managedExternally = state.externalService;

  const description = managedExternally
    ? gt(
        "Managed by the local t3 background service. Closing the window keeps agents and remote access running.",
      )
    : enabled
      ? gt(
          "This computer's server stays running in the background when you close the window, freeing window memory while keeping agents and remote access active.",
        )
      : gt(
          "Keep this computer's server running in the background when you close the window so agents and remote access stay active.",
        );

  const handleCheckedChange = async (checked: boolean) => {
    if (isUpdating || managedExternally) return;
    setPendingChecked(checked);
    try {
      if (checked) {
        await bridge.enableBackgroundService();
      } else {
        await bridge.disableBackgroundService();
      }
      refreshDesktopBackgroundServiceState();
    } catch (cause) {
      const message =
        cause instanceof Error
          ? (thrownErrorMessage(cause, m) ?? cause.message)
          : gt("Couldn't update the background service setting.");
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not update background service"),
          description: message,
        }),
      );
    } finally {
      setPendingChecked(null);
    }
  };

  return (
    <SettingsRow
      {...searchableSetting("background-service")}
      description={description}
      control={
        <Switch
          checked={enabled}
          disabled={isUpdating || managedExternally}
          onCheckedChange={(checked) => void handleCheckedChange(Boolean(checked))}
          aria-label={gt("Background service")}
        />
      }
    />
  );
}
