import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { m } from "~/i18n/messages";
import {
  desktopBackgroundServiceStateAtom,
  getDesktopBackgroundServiceBridge,
  refreshDesktopBackgroundServiceState,
} from "~/state/desktopBackgroundService";
import { useEnvironmentQuery } from "~/state/query";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

export function BackgroundServiceSetting() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const bridge = getDesktopBackgroundServiceBridge();
  const query = useEnvironmentQuery(bridge ? desktopBackgroundServiceStateAtom : null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const state = query.data;
  if (!bridge || !state?.supported) return null;

  const enabled = state.installed && state.otherBaseDir === null;
  const blockedByOtherHome = state.otherBaseDir !== null;

  const description = blockedByOtherHome
    ? gt("A background service is already installed for {path}.", { path: state.otherBaseDir })
    : enabled && state.attached
      ? gt(
          "This computer's server runs in the background. Closing the window keeps agents and remote access running.",
        )
      : enabled
        ? gt(
            "Background service is installed. Restart T3 Code to attach to it and keep agents running after closing the window.",
          )
        : gt(
            "Run this computer's server as a background service so closing the window keeps agents and remote access running.",
          );

  const applyChange = async () => {
    setIsUpdating(true);
    setError(null);
    try {
      if (enabled) {
        await bridge.disableBackgroundService();
      } else {
        await bridge.enableBackgroundService();
      }
      refreshDesktopBackgroundServiceState();
      setConfirmOpen(false);
      setIsUpdating(false);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? (thrownErrorMessage(cause, m) ?? cause.message)
          : gt("Couldn't change the background service."),
      );
      setIsUpdating(false);
    }
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("background-service")}
        description={description}
        control={
          <Switch
            checked={enabled}
            disabled={isUpdating || blockedByOtherHome}
            onCheckedChange={() => setConfirmOpen(true)}
            aria-label={gt("Background service")}
          />
        }
      />
      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (isUpdating) return;
          setConfirmOpen(open);
          if (!open) setError(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {enabled
                ? gt("Stop running as a background service?")
                : gt("Run as a background service?")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {enabled
                ? gt(
                    "T3 Code will uninstall the background service and restart with an embedded server. Closing the window will stop running agents and remote connections again.",
                  )
                : gt(
                    "T3 Code will install a user background service and restart to attach to it. Afterward, closing the desktop window frees window memory while agents and remote connections keep running.",
                  )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? <p className="px-6 pb-4 text-sm text-destructive">{error}</p> : null}
          <AlertDialogFooter>
            <AlertDialogClose disabled={isUpdating} render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant={enabled ? "destructive" : "default"}
              disabled={isUpdating}
              onClick={() => void applyChange()}
            >
              {isUpdating ? (
                <>
                  <Spinner size="sm" />
                  <T>Restarting…</T>
                </>
              ) : enabled ? (
                gt("Uninstall and restart")
              ) : (
                gt("Install and restart")
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
