import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";
import { ArrowRightIcon, DownloadIcon } from "lucide-react";

import { ensureLocalApi } from "../localApi";
import {
  getDesktopUpdateActionError,
  getDesktopUpdateDownloadedVersion,
  getDesktopUpdateInstallConfirmationMessage,
  getDesktopUpdateReleaseUrl,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";
import { toastManager } from "./ui/toast";
import { stackedThreadToast } from "./ui/toastHelpers";

type DesktopUpdateShell = Pick<DesktopBridge, "openExternal"> &
  Partial<Pick<DesktopBridge, "installUpdate">>;

export async function openDesktopUpdateReleaseNotes(
  shell: Pick<DesktopBridge, "openExternal"> | undefined,
  releaseUrl: string,
): Promise<void> {
  try {
    if (shell && (await shell.openExternal(releaseUrl))) return;
  } catch {}
  toastManager.add({ type: "error", title: "Unable to open release notes" });
}

/**
 * Confirms, then restarts into the downloaded update. Shared by the sidebar
 * update control and the update-downloaded toast's Restart now action.
 */
export async function installDesktopUpdate(
  bridge: Pick<DesktopBridge, "installUpdate" | "openExternal">,
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
): Promise<void> {
  let confirmed = false;
  try {
    confirmed = await ensureLocalApi().dialogs.confirm(
      getDesktopUpdateInstallConfirmationMessage(state),
    );
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not confirm update",
        description: error instanceof Error ? error.message : "Update confirmation failed.",
      }),
    );
    return;
  }
  if (!confirmed) return;

  try {
    const result = await bridge.installUpdate();
    if (!result.accepted) {
      showDesktopUpdateDownloadedToast(bridge, result.state);
      return;
    }
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
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not install update",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      }),
    );
  }
}

function ReleaseNotesLink({
  shell,
  releaseUrl,
}: {
  shell: DesktopUpdateShell;
  releaseUrl: string;
}) {
  return (
    <button
      className="ml-2 inline cursor-pointer text-muted-foreground underline decoration-dotted underline-offset-4 transition-colors hover:text-foreground"
      onClick={() => {
        void openDesktopUpdateReleaseNotes(shell, releaseUrl);
      }}
      type="button"
    >
      Release notes
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
  const version = getDesktopUpdateDownloadedVersion(state);
  const releaseUrl = getDesktopUpdateReleaseUrl(version);
  const installBridge = shell.installUpdate
    ? {
        installUpdate: shell.installUpdate.bind(shell),
        openExternal: shell.openExternal.bind(shell),
      }
    : null;
  toastManager.add(
    stackedThreadToast({
      type: "success",
      title: "Update downloaded",
      description: (
        <>
          {version ? `T3 Code ${version} is ready.` : "The update is ready."} Restart to finish
          updating.
          {releaseUrl ? <ReleaseNotesLink releaseUrl={releaseUrl} shell={shell} /> : null}
        </>
      ),
      ...(installBridge
        ? {
            actionProps: {
              children: "Restart now",
              onClick: () => {
                void installDesktopUpdate(installBridge, state);
              },
            },
            actionVariant: "secondary" as const,
          }
        : {}),
      data: {
        leadingIcon: (
          <DownloadIcon aria-hidden="true" className="size-[15px] text-success-foreground" />
        ),
      },
    }),
  );
}
