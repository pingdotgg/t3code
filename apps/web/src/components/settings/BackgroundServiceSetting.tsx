import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import type { DesktopBackgroundServiceState } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useRef, useState } from "react";

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
  const [optimisticState, setOptimisticState] = useState<DesktopBackgroundServiceState | null>(
    null,
  );
  const inFlightRef = useRef(false);

  const state = optimisticState ?? query.data;
  if (!bridge || !state?.supported) return null;

  const enabled = state.enabled;
  const managedExternally = state.externalService;

  const description = managedExternally
    ? gt(
        "Managed by the local t3 background service. Closing the window keeps agents and remote access running.",
      )
    : enabled
      ? gt(
          "Closing the window minimizes T3 Code to the system tray so agents and remote access stay active.",
        )
      : gt(
          "Keep T3 Code running in the system tray when you close the window so agents and remote access stay active.",
        );

  const handleCheckedChange = async (checked: boolean) => {
    if (inFlightRef.current || managedExternally) return;
    inFlightRef.current = true;
    const previousState = state;
    setOptimisticState({ ...previousState, enabled: checked });
    try {
      const next = checked
        ? await bridge.enableBackgroundService()
        : await bridge.disableBackgroundService();
      setOptimisticState(next);
      refreshDesktopBackgroundServiceState();
    } catch (cause) {
      setOptimisticState(previousState);
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
      inFlightRef.current = false;
    }
  };

  return (
    <SettingsRow
      {...searchableSetting("background-service")}
      description={description}
      control={
        <Switch
          checked={enabled}
          disabled={managedExternally}
          onCheckedChange={(checked) => void handleCheckedChange(Boolean(checked))}
          aria-label={gt("Background service")}
        />
      }
    />
  );
}
