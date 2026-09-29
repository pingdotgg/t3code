import { translate } from "@t3tools/i18n";
import { useState } from "react";

import { isLocalEnvironmentDisabled } from "../../localEnvironment";
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
import { searchableSetting } from "./settingsSearch";

// Toggling relaunches the desktop app, so the switch only reflects the value
// this process started with; there is no live state to keep in sync.
export function LocalEnvironmentSetting() {
  const setEnabled = window.desktopBridge?.setLocalEnvironmentEnabled;
  const [enabled] = useState(() => !isLocalEnvironmentDisabled());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!setEnabled) return null;

  const applyChange = async () => {
    setIsUpdating(true);
    setError(null);
    try {
      await setEnabled(!enabled);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : translate("common:uiCouldNotChangeSetting", "Couldn't change this setting."),
      );
      setIsUpdating(false);
    }
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("local-environment")}
        description={
          enabled
            ? translate(
                "common:uiLocalEnvironmentDescription",
                "Run agents on this computer. Turn off to use T3 Code only with remote environments.",
              )
            : translate(
                "common:uiLocalEnvironmentDisabledDescription",
                "Turned off. Agents only run in remote environments.",
              )
        }
        control={
          <Switch
            checked={enabled}
            disabled={isUpdating}
            onCheckedChange={() => setConfirmOpen(true)}
            aria-label={translate("common:uiLocalEnvironment", "Local environment")}
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
                ? translate("common:uiTurnOffLocalEnvironmentTitle", "Turn off local environment?")
                : translate("common:uiTurnOnLocalEnvironmentTitle", "Turn on local environment?")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {enabled
                ? translate(
                    "common:uiTurnOffLocalEnvironmentDescription",
                    "T3 Code will restart without running a server on this computer. Any agents and terminals running here will stop, and other devices will no longer be able to connect to this computer. Your projects, history, and remote environments are unaffected.",
                  )
                : translate(
                    "common:uiTurnOnLocalEnvironmentDescription",
                    "T3 Code will restart and start running a server on this computer again.",
                  )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? <p className="px-6 pb-4 text-sm text-destructive">{error}</p> : null}
          <AlertDialogFooter>
            <AlertDialogClose disabled={isUpdating} render={<Button variant="outline" />}>
              {translate("chatView:cancel", "Cancel")}
            </AlertDialogClose>
            <Button
              variant={enabled ? "destructive" : "default"}
              disabled={isUpdating}
              onClick={() => void applyChange()}
            >
              {isUpdating ? (
                <>
                  <Spinner size="sm" />
                  {translate("common:uiRestarting", "Restarting…")}
                </>
              ) : enabled ? (
                translate("common:uiRestartAndTurnOff", "Restart and turn off")
              ) : (
                translate("common:uiRestartAndTurnOn", "Restart and turn on")
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
