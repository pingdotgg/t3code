import { DownloadIcon } from "lucide-react";
import { msg, T, useGT, useMessages, Var } from "gt-react";
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
  DialogAction,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { appName } from "@t3tools/shared/appName";
const installSteps: ReadonlyArray<{
  readonly stage: RelayClientInstallProgressStage;
  readonly label: string;
}> = [
  { stage: "checking", label: msg("Checking current installation") },
  { stage: "waiting_for_lock", label: msg("Waiting for installer") },
  { stage: "downloading", label: msg("Downloading relay client") },
  { stage: "verifying", label: msg("Verifying download") },
  { stage: "installing", label: msg("Installing relay client") },
  { stage: "validating", label: msg("Validating executable") },
  { stage: "activating", label: msg("Activating installation") },
];

export function RelayClientInstallDialog() {
  const state = useSyncExternalStore(
    subscribeRelayClientInstallDialog,
    readRelayClientInstallDialogState,
    readRelayClientInstallDialogState,
  );
  const gt = useGT();
  const m = useMessages();
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
            {isInstalling ? gt("Installing relay client") : gt("Install relay client?")}
          </DialogTitle>
          <DialogDescription>
            {isInstalling
              ? gt(
                  "{appName} is preparing this environment for secure access through T3 Connect.",
                  { appName: appName() },
                )
              : gt(
                  "{appName} needs the relay client to make this environment available through T3 Connect.",
                  { appName: appName() },
                )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel scrollFade={false}>
          {isInstalling ? (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-3 text-sm">
                <p aria-live="polite" className="font-medium text-foreground">
                  {activeStep ? m(activeStep.label) : null}
                </p>
                <p className="shrink-0 tabular-nums text-muted-foreground">
                  {gt("{step} of {total}", {
                    step: activeStepIndex + 1,
                    total: installSteps.length,
                  })}
                </p>
              </div>
              <progress
                aria-label={gt("Relay client installation progress")}
                className="h-2 w-full appearance-none overflow-hidden rounded-full bg-muted [&::-moz-progress-bar]:rounded-full [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary"
                max={installSteps.length}
                value={activeStepIndex + 1}
              />
              <p className="text-xs leading-relaxed text-muted-foreground">
                <T>
                  Keep <Var>{appName()}</Var> open while the relay client is installed.
                </T>
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-border/70 bg-muted/35 p-3">
              <p className="text-sm font-medium text-foreground">
                <T>Managed relay client</T>
              </p>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                <T>
                  <Var>{appName()}</Var> will download and install version{" "}
                  <Var>{view.status === "confirming" ? view.version : ""}</Var> locally.
                </T>
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
              <T>Cancel</T>
            </Button>
            <DialogAction onClick={() => respondToRelayClientInstallConfirmation(true)}>
              <T>Download and install</T>
            </DialogAction>
          </DialogFooter>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
