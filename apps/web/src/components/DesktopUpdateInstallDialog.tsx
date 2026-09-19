import { useAtomValue } from "@effect/atom-react";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import { useEffect } from "react";
import { useStore } from "zustand";
import { Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { desktopLocalBackendId } from "../connection/desktopLocal";
import { desktopUpdateScheduler, hasDesktopUpdateBlockingWork } from "../desktopUpdateScheduler";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { allEnvironmentProjectSnapshotsReadyAtom } from "../state/shell";
import { environmentThreadShells } from "../state/threads";
import { useDesktopUpdateState } from "../state/desktopUpdate";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { toastManager } from "./ui/toast";

const agentsIdleAtom = Atom.make(
  (get) =>
    get(allEnvironmentProjectSnapshotsReadyAtom) &&
    !get(environmentThreadShells.threadShellsAtom).some(hasDesktopUpdateBlockingWork),
);

function allAgentsIdle(): boolean {
  if (!appAtomRegistry.get(agentsIdleAtom)) return false;
  const bridge = window.desktopBridge;
  if (!bridge) return false;
  // A local backend must not disappear from the safety check while its client
  // connection is being registered (or has been disabled in the catalog).
  try {
    const entries = [...appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.values()];
    return bridge
      .getLocalEnvironmentBootstraps()
      .every((backend) =>
        entries.some(
          (entry) =>
            entry.enabled &&
            (backend.id === PRIMARY_LOCAL_ENVIRONMENT_ID
              ? entry.target._tag === "PrimaryConnectionTarget"
              : desktopLocalBackendId(entry.target) === backend.id),
        ),
      );
  } catch {
    return false;
  }
}

function install(whenIdle: boolean) {
  const bridge = window.desktopBridge;
  if (!bridge) return;
  return desktopUpdateScheduler.install({
    whenIdle,
    isIdle: allAgentsIdle,
    getUpdateState: () => bridge.getUpdateState(),
    installUpdate: () => bridge.installUpdate(),
    onError: (description) =>
      toastManager.add({ type: "error", title: "Could not install update", description }),
  });
}

function ScheduledUpdateWatcher({ installing }: { installing: boolean }) {
  const idle = useAtomValue(agentsIdleAtom);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  useEffect(() => {
    if (idle && catalog.entries.size > 0 && !installing) void install(true);
  }, [catalog, installing, idle]);
  return null;
}

/** Mounted above navigation so a queued update survives switching threads or settings. */
export function DesktopUpdateInstallDialog() {
  const state = useStore(desktopUpdateScheduler.store);
  const update = useDesktopUpdateState();

  useEffect(() => {
    if (state.scheduledVersion && update && update.downloadedVersion !== state.scheduledVersion) {
      desktopUpdateScheduler.cancel();
      toastManager.add({
        type: "info",
        title: "Scheduled update cancelled",
        description: "The downloaded version changed. Select an update again.",
      });
    }
  }, [state.scheduledVersion, update]);

  return (
    <>
      {state.scheduledVersion ? (
        <>
          <ScheduledUpdateWatcher key={state.scheduledVersion} installing={state.installing} />
          <div
            role="status"
            className="fixed bottom-4 right-4 z-50 flex max-w-sm items-center gap-3 rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-lg"
          >
            <span>Update to {state.scheduledVersion} when idle. Keep this window open.</span>
            <Button size="sm" variant="outline" onClick={desktopUpdateScheduler.cancel}>
              Cancel update
            </Button>
          </div>
        </>
      ) : null}
      <AlertDialog
        open={state.dialogVersion !== null}
        onOpenChange={(open) => {
          if (!open) desktopUpdateScheduler.close();
        }}
      >
        <AlertDialogPopup className="max-w-xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Update to {state.dialogVersion}?</AlertDialogTitle>
            <AlertDialogDescription>
              Update now restarts T3 Code and interrupts running agents. Or keep this window open to
              update automatically when all agents in your enabled environments are idle.
              Disconnected environments, agents waiting for input, and background agents will keep
              the update waiting.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={desktopUpdateScheduler.close}>
              Cancel
            </Button>
            <Button
              disabled={state.installing}
              variant="outline"
              onClick={() => void install(false)}
            >
              Update now
            </Button>
            <Button disabled={state.installing} onClick={desktopUpdateScheduler.schedule}>
              Update when idle
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
