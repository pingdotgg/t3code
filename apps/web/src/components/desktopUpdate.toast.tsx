import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";
import { ArrowRightIcon } from "lucide-react";

import type { Translate } from "../i18n";
import {
  getDesktopUpdateDownloadedVersion,
  getDesktopUpdateReleaseUrl,
} from "./desktopUpdate.logic";
import { toastManager } from "./ui/toast";

type DesktopUpdateShell = Pick<DesktopBridge, "openExternal">;

function ReleaseNotesLink({
  shell,
  releaseUrl,
  t,
}: {
  shell: DesktopUpdateShell;
  releaseUrl: string;
  t?: Translate;
}) {
  return (
    <button
      className="ml-2 inline cursor-pointer text-muted-foreground underline decoration-dotted underline-offset-4 transition-colors hover:text-foreground"
      onClick={() => {
        void (async () => {
          try {
            if (await shell.openExternal(releaseUrl)) return;
          } catch {
            // Surface rejected IPC calls through the same user-visible fallback.
          }
          toastManager.add({
            type: "error",
            title: t?.("update.releaseNotesOpenFailed") ?? "Unable to open release notes",
          });
        })();
      }}
      type="button"
    >
      {t?.("update.readMore") ?? "Read more"}
      <ArrowRightIcon
        aria-hidden
        className="ml-1 inline size-3 -rotate-45 align-[-0.125em]"
        strokeWidth={2.25}
      />
    </button>
  );
}

export function showDesktopUpdateDownloadedToast(
  shell: DesktopUpdateShell,
  state: DesktopUpdateState,
  t?: Translate,
): void {
  const releaseUrl = getDesktopUpdateReleaseUrl(getDesktopUpdateDownloadedVersion(state));
  toastManager.add({
    type: "success",
    title: t?.("update.downloaded") ?? "Update downloaded",
    description: (
      <>
        {t?.("update.downloadedDescription") ??
          "Restart the app from the update button to install it."}
        {releaseUrl ? (
          <ReleaseNotesLink releaseUrl={releaseUrl} shell={shell} {...(t ? { t } : {})} />
        ) : null}
      </>
    ),
  });
}
