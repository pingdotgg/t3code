import { translate } from "@t3tools/i18n";
import { DownloadIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import type { RelayClientInstallProgressStage } from "@t3tools/contracts";

import {
  completeRelayClientInstallDialogClose,
  readRelayClientInstallDialogState,
  respondToRelayClientInstallConfirmation,
  subscribeRelayClientInstallDialog,
} from "../../cloud/relayClientInstallDialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
const installSteps: ReadonlyArray<{
  readonly stage: RelayClientInstallProgressStage;
  readonly label: string;
}> = [
  { stage: "checking", label: "Checking current installation" },
  { stage: "waiting_for_lock", label: "Waiting for installer" },
  { stage: "downloading", label: "Downloading relay client" },
  { stage: "verifying", label: "Verifying download" },
  { stage: "installing", label: "Installing relay client" },
  { stage: "validating", label: "Validating executable" },
  { stage: "activating", label: "Activating installation" },
];

export function RelayClientInstallDialog() {
  const state = useSyncExternalStore(
    subscribeRelayClientInstallDialog,
    readRelayClientInstallDialogState,
    readRelayClientInstallDialogState,
  );
  const view = state.status === "closing" ? state.view : state;
  const isConfirming = view.status === "confirming";
  const isInstalling = view.status === "installing";
  const activeStepIndex = isInstalling
    ? installSteps.findIndex(({ stage }) => stage === view.stage)
    : -1;
  const activeStep = installSteps[activeStepIndex];

  return (
    <Dialog
      open={state.status === "confirming" || state.status === "installing"}
      onOpenChange={(open) => {
        if (!open && isConfirming) {
          respondToRelayClientInstallConfirmation(false);
        }
      }}
      onOpenChangeComplete={(open) => {
        if (!open) {
          completeRelayClientInstallDialogClose();
        }
      }}
    >
      <DialogPopup className="max-w-md" showCloseButton={isConfirming}>
        <DialogHeader>
          <div className="flex size-9 items-center justify-center rounded-lg border border-border/70 bg-muted/60">
            <DownloadIcon aria-hidden className="size-4.5 text-muted-foreground" />
          </div>
          <DialogTitle>
            {isInstalling
              ? translate("common:uiInstallingRelayClient", "Installing relay client")
              : translate("common:uiInstallRelayClient", "Install relay client?")}
          </DialogTitle>
          <DialogDescription>
            {isInstalling
              ? translate(
                  "common:uiRelayClientInstallProgressDescription",
                  "T3 Code is preparing this environment for secure access through T3 Connect.",
                )
              : translate(
                  "common:uiRelayClientInstallPromptDescription",
                  "T3 Code needs the relay client to make this environment available through T3 Connect.",
                )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel scrollFade={false}>
          {isInstalling ? (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-3 text-sm">
                <p aria-live="polite" className="font-medium text-foreground">
                  {activeStep?.label}
                </p>
                <p className="shrink-0 tabular-nums text-muted-foreground">
                  {translate("common:uiRelayInstallStep", "{{current}} of {{total}}", {
                    current: activeStepIndex + 1,
                    total: installSteps.length,
                  })}
                </p>
              </div>
              <progress
                aria-label={translate(
                  "common:uiRelayClientInstallationProgress",
                  "Relay client installation progress",
                )}
                className="h-2 w-full appearance-none overflow-hidden rounded-full bg-muted [&::-moz-progress-bar]:rounded-full [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary"
                max={installSteps.length}
                value={activeStepIndex + 1}
              />
              <p className="text-xs leading-relaxed text-muted-foreground">
                {translate(
                  "common:uiKeepAppOpenWhileRelayInstalled",
                  "Keep T3 Code open while the relay client is installed.",
                )}
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-border/70 bg-muted/35 p-3">
              <p className="text-sm font-medium text-foreground">
                {translate("chatView:managedRelayClient", "Managed relay client")}
              </p>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                {translate(
                  "common:uiRelayInstallVersion",
                  "T3 Code will download and install version {{version}} locally.",
                  { version: view.status === "confirming" ? view.version : "" },
                )}
              </p>
            </div>
          )}
        </DialogPanel>
        {isConfirming ? (
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => respondToRelayClientInstallConfirmation(false)}
            >
              {translate("chatView:cancel", "Cancel")}
            </Button>
            <Button onClick={() => respondToRelayClientInstallConfirmation(true)}>
              {translate("settings:downloadAndInstall", "Download and install")}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
