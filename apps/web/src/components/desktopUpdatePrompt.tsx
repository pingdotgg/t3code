import { useState } from "react";

import { isElectron } from "../env";
import { useDesktopUpdateState } from "../state/desktopUpdate";
import { getDesktopUpdatePrompt } from "./desktopUpdate.logic";
import { downloadLocalUpdate, installLocalUpdate } from "./sidebar/SidebarUpdatePill";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";

export function DesktopUpdatePrompt() {
  const state = useDesktopUpdateState();
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const [autoUpdate, setAutoUpdate] = useState(false);
  const [pending, setPending] = useState(false);
  if (!isElectron || !state) return null;
  const prompt = getDesktopUpdatePrompt(state, dismissedVersion);
  const version = prompt === "available" ? state.availableVersion : state.downloadedVersion;
  const bridge = window.desktopBridge;
  if (!prompt || !version || !bridge) return null;
  const dismiss = () => setDismissedVersion(version);
  const later = () => {
    if (autoUpdate && prompt === "available") void bridge.setAutoUpdate(true);
    dismiss();
  };
  const update = async () => {
    if (pending) return;
    setPending(true);
    try {
      if (autoUpdate && prompt === "available") await bridge.setAutoUpdate(true);
      if (prompt === "available") {
        const downloaded = await downloadLocalUpdate(bridge, { notifyDownloaded: false });
        if (!downloaded) {
          setPending(false);
          return;
        }
      }
      await installLocalUpdate(bridge);
    } catch {
      setPending(false);
      return;
    }
    setPending(false);
  };
  const title =
    prompt === "available" ? `T3 Learn ${version} is available` : `T3 Learn ${version} is ready`;
  return (
    <AlertDialog open onOpenChange={(open) => !open && dismiss()}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>You're on {state.currentVersion}.</AlertDialogDescription>
        </AlertDialogHeader>
        {prompt === "available" ? (
          <label className="flex items-center gap-2 px-6 pb-4 text-sm">
            <Checkbox
              checked={autoUpdate}
              onCheckedChange={(checked) => setAutoUpdate(checked === true)}
            />
            Update automatically from now on
          </label>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogClose
            render={<Button variant="outline" disabled={pending} onClick={later} />}
          >
            Later
          </AlertDialogClose>
          <Button disabled={pending} onClick={() => void update()}>
            {prompt === "available" ? "Update now" : "Restart to update"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
