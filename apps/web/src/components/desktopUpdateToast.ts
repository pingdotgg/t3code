import type {
  DesktopToastAction,
  DesktopUpdateActionResult,
  DesktopUpdateCheckResult,
} from "@t3tools/contracts";
import { getDesktopUpdateActionError } from "./desktopUpdate.logic";
import { toastManager } from "./ui/toast";

function formatUnexpectedDesktopUpdateError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return fallback;
}

function getDesktopUpdateActionErrorToastAction(
  action: DesktopToastAction | null,
): { children: string; onClick: () => void } | undefined {
  if (!action) return undefined;
  return {
    children: action.label,
    onClick: () => {
      void runDesktopToastAction(action);
    },
  };
}

function showDesktopUpdateDownloadResultToast(result: DesktopUpdateActionResult): void {
  if (result.completed) {
    toastManager.add({
      type: "success",
      title: "Update downloaded",
      description: "Restart the app from the update button to install it.",
    });
  }

  const actionError = getDesktopUpdateActionError(result);
  if (!actionError) return;
  toastManager.add({
    type: "error",
    title: "Could not download update",
    description: actionError,
    actionProps: getDesktopUpdateActionErrorToastAction(result.state.toastAction),
  });
}

function showDesktopUpdateInstallResultToast(result: DesktopUpdateActionResult): void {
  const actionError = getDesktopUpdateActionError(result);
  if (!actionError) return;
  toastManager.add({
    type: "error",
    title: "Could not install update",
    description: actionError,
    actionProps: getDesktopUpdateActionErrorToastAction(result.state.toastAction),
  });
}

async function runDesktopToastAction(action: DesktopToastAction): Promise<void> {
  const bridge = window.desktopBridge;
  if (!bridge) return;

  switch (action.kind) {
    case "desktop-update.retry-download": {
      try {
        const result = await bridge.downloadUpdate();
        showDesktopUpdateDownloadResultToast(result);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not start update download",
          description: formatUnexpectedDesktopUpdateError(error, "An unexpected error occurred."),
        });
      }
      return;
    }
  }
}

export function toastDesktopUpdateDownloadResult(result: DesktopUpdateActionResult): void {
  showDesktopUpdateDownloadResultToast(result);
}

export function toastDesktopUpdateInstallResult(result: DesktopUpdateActionResult): void {
  showDesktopUpdateInstallResultToast(result);
}

export function toastDesktopUpdateCheckFailure(result: DesktopUpdateCheckResult): void {
  if (result.checked) return;
  toastManager.add({
    type: "error",
    title: "Could not check for updates",
    description: result.state.message ?? "Automatic updates are not available in this build.",
    actionProps: getDesktopUpdateActionErrorToastAction(result.state.toastAction),
  });
}

export function toastDesktopUpdateUnexpectedError(
  phase: "check" | "download" | "install",
  error: unknown,
): void {
  const titles: Record<"check" | "download" | "install", string> = {
    check: "Could not check for updates",
    download: "Could not start update download",
    install: "Could not install update",
  };
  const fallbacks: Record<"check" | "download" | "install", string> = {
    check: "Update check failed.",
    download: "An unexpected error occurred.",
    install: "An unexpected error occurred.",
  };
  toastManager.add({
    type: "error",
    title: titles[phase],
    description: formatUnexpectedDesktopUpdateError(error, fallbacks[phase]),
  });
}
