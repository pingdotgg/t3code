import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { CircleCheckIcon, CircleIcon, DownloadIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import type { RelayClientInstallProgressStage } from "@t3tools/contracts";

import {
  cancelRelayClientInstall,
  completeRelayClientInstallDialogClose,
  readRelayClientInstallDialogState,
  type RelayClientInstallingState,
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
import { Spinner } from "../ui/spinner";

// The checklist shows five steps. The lock wait and the extract stage are
// short and ride on the neighbouring step, whose label switches while they run.
const installSteps: ReadonlyArray<{
  readonly label: string;
  readonly stages: ReadonlyArray<RelayClientInstallProgressStage>;
  readonly activeLabels?: Partial<Record<RelayClientInstallProgressStage, string>>;
}> = [
  {
    label: "Checking current installation",
    stages: ["checking", "waiting_for_lock"],
    activeLabels: { waiting_for_lock: "Waiting for installer" },
  },
  { label: "Downloading relay client", stages: ["downloading"] },
  { label: "Verifying download", stages: ["verifying"] },
  {
    label: "Validating executable",
    stages: ["installing", "validating"],
    activeLabels: { installing: "Installing relay client" },
  },
  { label: "Activating installation", stages: ["activating"] },
];

function stepMeta(index: number, view: RelayClientInstallingState): string | null {
  if (index === 1 && view.downloadedBytes !== undefined) {
    return formatAttachmentSize(view.downloadedBytes);
  }
  if (index === 2 && view.checksumVerified) {
    return "sha256 ok";
  }
  return null;
}

function RelayClientInstallChecklist({ view }: { readonly view: RelayClientInstallingState }) {
  const activeIndex = installSteps.findIndex(({ stages }) => stages.includes(view.stage));
  // Half a step for the running one, so the bar moves as each step starts.
  const progress = Math.max(0, activeIndex + 0.5) / installSteps.length;

  return (
    <div className="flex flex-col gap-4">
      <ol
        aria-label="Relay client installation steps"
        className="flex flex-col gap-2 rounded-lg surface-well px-3 py-2.5 text-body"
      >
        {installSteps.map((step, index) => {
          const state = index < activeIndex ? "done" : index === activeIndex ? "active" : "pending";
          const meta = stepMeta(index, view);
          return (
            <li
              key={step.label}
              aria-current={state === "active" ? "step" : undefined}
              className="flex min-w-0 items-center gap-2"
            >
              {state === "done" ? (
                <CircleCheckIcon aria-hidden className="size-3.5 shrink-0 text-success" />
              ) : state === "active" ? (
                <span aria-hidden className="flex shrink-0 text-update-foreground">
                  <Spinner size="sm" />
                </span>
              ) : (
                <CircleIcon aria-hidden className="size-3.5 shrink-0 text-dim-foreground" />
              )}
              <span
                aria-live={state === "active" ? "polite" : undefined}
                className={`min-w-0 flex-1 truncate ${state === "pending" ? "text-dim-foreground" : "text-foreground"}`}
              >
                {(state === "active" ? step.activeLabels?.[view.stage] : undefined) ?? step.label}
              </span>
              {meta ? (
                <span className="shrink-0 font-mono text-meta text-dim-foreground">{meta}</span>
              ) : null}
            </li>
          );
        })}
      </ol>
      <div
        aria-label="Relay client installation progress"
        aria-valuemax={installSteps.length}
        aria-valuemin={0}
        aria-valuenow={activeIndex + 1}
        className="h-1 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
      >
        <div
          className="h-full rounded-full bg-update transition-[width] duration-300"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
    </div>
  );
}

export function RelayClientInstallDialog() {
  const state = useSyncExternalStore(
    subscribeRelayClientInstallDialog,
    readRelayClientInstallDialogState,
    readRelayClientInstallDialogState,
  );
  const view = state.status === "closing" ? state.view : state;
  const isConfirming = view.status === "confirming";
  const installingView = view.status === "installing" ? view : null;
  // Activation is an atomic rename; there is nothing left to cancel.
  const canCancelInstall =
    installingView !== null && !installingView.cancelling && installingView.stage !== "activating";

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
          {isConfirming ? (
            <div className="flex size-9 items-center justify-center rounded-control surface-well">
              <DownloadIcon aria-hidden className="size-4.5 text-muted-foreground" />
            </div>
          ) : null}
          <DialogTitle>Install relay client?</DialogTitle>
          <DialogDescription>
            T3 Connect uses a managed relay client to reach this machine from your other devices.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel scrollFade={false}>
          {installingView ? (
            <RelayClientInstallChecklist view={installingView} />
          ) : (
            <div className="rounded-card surface-panel p-3">
              <p className="text-label text-strong-foreground">Managed relay client</p>
              <p className="mt-1 text-body leading-relaxed text-muted-foreground">
                T3 Code will download and install version{" "}
                {view.status === "confirming" ? view.version : ""} locally.
              </p>
            </div>
          )}
        </DialogPanel>
        {isConfirming ? (
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => respondToRelayClientInstallConfirmation(false)}
            >
              Cancel
            </Button>
            <Button onClick={() => respondToRelayClientInstallConfirmation(true)}>
              Download and install
            </Button>
          </DialogFooter>
        ) : installingView ? (
          <DialogFooter className="sm:items-center sm:justify-between">
            <p className="text-meta text-dim-foreground">Managed relay client</p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button
                disabled={!canCancelInstall}
                onClick={cancelRelayClientInstall}
                variant="secondary"
              >
                {installingView.cancelling ? "Cancelling..." : "Cancel"}
              </Button>
              <Button disabled>Installing...</Button>
            </div>
          </DialogFooter>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
