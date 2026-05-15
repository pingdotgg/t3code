import type { DesktopUpdateState } from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { ExternalLinkIcon } from "lucide-react";

import {
  getDesktopUpdateLatestVersion,
  getDesktopUpdateReleaseNotesUrl,
} from "./desktopUpdate.logic";
import { readLocalApi } from "../localApi";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { TooltipPopup } from "./ui/tooltip";

type DesktopUpdateTooltipPopupProps = {
  state: DesktopUpdateState | null;
  summary: string;
  side?: ComponentProps<typeof TooltipPopup>["side"];
};

function getDesktopUpdateTooltipTitle(state: DesktopUpdateState | null): string {
  if (!state) return "Update Available";
  if (state.status === "downloaded") return "Restart to Update";
  if (state.status === "downloading") return "Downloading Update";
  if (state.status === "error") return "Update Needs Attention";
  if (state.status === "available") return "Update Available";
  return "Application Update";
}

function openReleaseNotes(state: DesktopUpdateState | null) {
  const api = readLocalApi();
  const url = getDesktopUpdateReleaseNotesUrl(state);
  void api?.shell.openExternal(url).catch((error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not open release notes",
        description: error instanceof Error ? error.message : "Unable to open GitHub Releases.",
      }),
    );
  });
}

export function DesktopUpdateTooltipPopup({
  state,
  summary,
  side = "top",
}: DesktopUpdateTooltipPopupProps) {
  const latestVersion = state ? getDesktopUpdateLatestVersion(state) : null;

  return (
    <TooltipPopup side={side} className="w-72 text-left">
      <div className="flex flex-col gap-3 py-1">
        <div className="flex flex-col gap-1">
          <div className="text-sm font-semibold text-popover-foreground">
            {getDesktopUpdateTooltipTitle(state)}
          </div>
          <div className="text-xs leading-snug text-muted-foreground">{summary}</div>
        </div>
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
          <span className="text-muted-foreground">Current Version</span>
          <span className="min-w-0 truncate font-mono text-popover-foreground">
            {state?.currentVersion ?? "Unknown"}
          </span>
          <span className="text-muted-foreground">Latest Version</span>
          <span className="min-w-0 truncate font-mono text-popover-foreground">
            {latestVersion ?? "Unknown"}
          </span>
        </div>
        <button
          type="button"
          className="inline-flex h-8 w-fit items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          onClick={() => openReleaseNotes(state)}
        >
          Release Notes
          <ExternalLinkIcon className="size-3" />
        </button>
      </div>
    </TooltipPopup>
  );
}
