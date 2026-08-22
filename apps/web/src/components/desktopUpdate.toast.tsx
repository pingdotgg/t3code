import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";
import { ArrowRightIcon } from "lucide-react";

import {
  getDesktopUpdateActionError,
  getDesktopUpdateDownloadedVersion,
  getDesktopUpdateReleaseUrl,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

type DesktopUpdateShell = Pick<DesktopBridge, "installUpdate" | "openExternal">;

function ReleaseNotesLink({
  shell,
  releaseUrl,
}: {
  shell: DesktopUpdateShell;
  releaseUrl: string;
}) {
  return (
    <button
      className="inline cursor-pointer text-muted-foreground underline decoration-dotted underline-offset-4 transition-colors hover:text-foreground"
      onClick={() => {
        void (async () => {
          try {
            if (await shell.openExternal(releaseUrl)) return;
          } catch {
            // Surface rejected IPC calls through the same user-visible fallback.
          }
          toastManager.add({ type: "error", title: "Unable to open release notes" });
        })();
      }}
      type="button"
    >
      Read more
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
): void {
  const releaseUrl = getDesktopUpdateReleaseUrl(getDesktopUpdateDownloadedVersion(state));
  toastManager.add({
    type: "success",
    title: "Update downloaded",
    description: (
      <>
        Restart the app to install it.
        {releaseUrl ? (
          <>
            {" "}
            <ReleaseNotesLink releaseUrl={releaseUrl} shell={shell} />
          </>
        ) : null}
      </>
    ),
    actionProps: {
      children: "Restart",
      onClick: () => {
        void shell
          .installUpdate()
          .then((result) => {
            if (!shouldToastDesktopUpdateActionResult(result)) return;
            const actionError = getDesktopUpdateActionError(result);
            if (!actionError) return;
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Could not install update",
                description: actionError,
              }),
            );
          })
          .catch((error) => {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Could not install update",
                description:
                  error instanceof Error ? error.message : "An unexpected error occurred.",
              }),
            );
          });
      },
    },
  });
}
