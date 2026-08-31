import type { DesktopUpdateState } from "@t3tools/contracts";

import { DesktopUpdateReleaseNotes } from "./desktopUpdate.releaseNotes";
import { toastManager } from "./ui/toast";

export function showDesktopUpdateDownloadedToast(state: DesktopUpdateState): void {
  const hasReleaseNotes = state.releaseNotes.length > 0;
  toastManager.add({
    data: hasReleaseNotes
      ? {
          expandableContent: <DesktopUpdateReleaseNotes releaseNotes={state.releaseNotes} />,
          expandableLabels: { collapse: "Hide changes", expand: "View changes" },
        }
      : undefined,
    type: "success",
    title: "Update downloaded",
    description: "Restart the app from the update button to install it.",
  });
}
