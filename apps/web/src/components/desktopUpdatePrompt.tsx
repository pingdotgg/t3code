import { useState } from "react";

import { isElectron } from "../env";
import { useDesktopUpdateState } from "../state/desktopUpdate";
import { getDesktopUpdatePrompt } from "./desktopUpdate.logic";
import { downloadLocalUpdate, installLocalUpdate } from "./sidebar/SidebarUpdatePill";
import { DesktopUpdateReleaseNoteList } from "./sidebar/SidebarUpdateReleaseNotes";
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
  // Close first: the sidebar pill shows download progress, and failures toast.
  const update = async () => {
    later();
    if (prompt === "available" && !(await downloadLocalUpdate(bridge, { notifyDownloaded: false })))
      return;
    await installLocalUpdate(bridge);
  };
  const title =
    prompt === "available" ? `OminaX ${version} is available` : `OminaX ${version} is ready`;
  return (
    <AlertDialog open onOpenChange={(open) => !open && dismiss()}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>You're on {state.currentVersion}.</AlertDialogDescription>
        </AlertDialogHeader>
        {state.releaseNotes.length > 0 ? (
          <div className="flex min-h-0 flex-col px-5">
            <DesktopUpdateReleaseNoteList shell={bridge} state={state} />
          </div>
        ) : null}
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
          <AlertDialogClose render={<Button variant="outline" onClick={later} />}>
            Later
          </AlertDialogClose>
          <Button onClick={() => void update()}>
            {prompt === "available" ? "Update now" : "Restart to update"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
