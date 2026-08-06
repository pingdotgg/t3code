import { useCallback, useSyncExternalStore } from "react";
import type { DesktopUpdateState } from "@t3tools/contracts";

import { isElectron } from "../env";
import { useDesktopUpdateState } from "../state/desktopUpdate";
import {
  canCheckForUpdate,
  getDesktopUpdateActionError,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";
import { stackedThreadToast, toastManager } from "./ui/toast";

const CHECK_SETTLE_TIMEOUT_MS = 60_000;
const CHECK_SETTLE_POLL_MS = 200;

/** Module-scoped so banner dismiss / route changes cannot drop an in-flight check. */
let clientUpdateCheckInFlight = false;
const clientUpdateCheckListeners = new Set<() => void>();

function setClientUpdateCheckInFlight(next: boolean): void {
  if (clientUpdateCheckInFlight === next) return;
  clientUpdateCheckInFlight = next;
  for (const listener of clientUpdateCheckListeners) {
    listener();
  }
}

function subscribeClientUpdateCheckInFlight(listener: () => void): () => void {
  clientUpdateCheckListeners.add(listener);
  return () => {
    clientUpdateCheckListeners.delete(listener);
  };
}

function getClientUpdateCheckInFlightSnapshot(): boolean {
  return clientUpdateCheckInFlight;
}

function useClientUpdateCheckInFlight(): boolean {
  return useSyncExternalStore(
    subscribeClientUpdateCheckInFlight,
    getClientUpdateCheckInFlightSnapshot,
    () => false,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function downloadDesktopUpdate(): void {
  const bridge = window.desktopBridge;
  if (!bridge) return;
  void bridge
    .downloadUpdate()
    .then((result) => {
      if (result.completed) {
        toastManager.add({
          type: "success",
          title: "Update downloaded",
          description: "Restart the app from the update button to install it.",
        });
      }
      if (!shouldToastDesktopUpdateActionResult(result)) return;
      const actionError = getDesktopUpdateActionError(result);
      if (!actionError) return;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not download update",
          description: actionError,
        }),
      );
    })
    .catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not start update download",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    });
}

function handleSettledCheckState(state: DesktopUpdateState): void {
  const nextAction = resolveDesktopUpdateButtonAction(state);
  if (nextAction === "download") {
    downloadDesktopUpdate();
    return;
  }
  if (nextAction === "install") {
    return;
  }
  if (state.status === "up-to-date") {
    toastManager.add({
      type: "info",
      title: "No newer desktop update found",
      description:
        "This build may not have a published update yet. Install a newer T3 Code desktop build to match the server.",
    });
    return;
  }
  if (state.status === "error") {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not check for updates",
        description: state.message ?? "Update check failed.",
      }),
    );
  }
}

/**
 * Runs check → wait for settled desktop update state → download. Lives outside
 * React so unmounting ClientUpdateAction (dismiss banner / leave Connections)
 * cannot cancel the continuation.
 *
 * Returns whether this call owned the in-flight work.
 */
async function checkThenDownloadDesktopUpdate(
  baselineCheckedAt: string | null,
): Promise<"owned" | "skipped"> {
  const bridge = window.desktopBridge;
  if (!bridge || typeof bridge.checkForUpdate !== "function") return "skipped";
  if (clientUpdateCheckInFlight) return "skipped";

  setClientUpdateCheckInFlight(true);
  try {
    const result = await bridge.checkForUpdate();
    if (!result.checked) {
      // `checked: false` is not always a hard failure — desktop skips starting a
      // second check while one is already in flight (or while download/install is
      // active). Join the in-flight check via polling; otherwise act on current state.
      if (result.state.status === "checking") {
        // fall through to the settle poll below
      } else {
        handleSettledCheckState(result.state);
        const nextAction = resolveDesktopUpdateButtonAction(result.state);
        if (
          nextAction === "none" &&
          result.state.status !== "downloading" &&
          result.state.status !== "up-to-date" &&
          result.state.status !== "error"
        ) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not check for updates",
              description:
                result.state.message ?? "Automatic updates are not available in this build.",
            }),
          );
        }
        return "owned";
      }
    }

    const deadline = Date.now() + CHECK_SETTLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = await bridge.getUpdateState();
      const checkAdvanced = state.status === "checking" || state.checkedAt !== baselineCheckedAt;
      if (!checkAdvanced || state.status === "checking") {
        await sleep(CHECK_SETTLE_POLL_MS);
        continue;
      }
      handleSettledCheckState(state);
      return "owned";
    }

    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not check for updates",
        description: "Timed out waiting for the desktop updater to finish checking.",
      }),
    );
    return "owned";
  } catch (error: unknown) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not check for updates",
        description: error instanceof Error ? error.message : "Update check failed.",
      }),
    );
    return "owned";
  } finally {
    setClientUpdateCheckInFlight(false);
  }
}

/**
 * Call-to-action when this client is behind the connected server. On desktop,
 * drives the Electron updater (check → download → install). Elsewhere, only
 * guidance text is shown — there is no server-install path for this case.
 */
export function ClientUpdateAction({ label = "Update client" }: { readonly label?: string }) {
  const updateState = useDesktopUpdateState();
  const checkInFlight = useClientUpdateCheckInFlight();

  const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";
  const checking = updateState?.status === "checking" || checkInFlight;
  const downloading = updateState?.status === "downloading";
  const updatesDisabled =
    updateState !== null && (!updateState.enabled || updateState.status === "disabled");
  const buttonDisabled =
    checking ||
    downloading ||
    (action === "none"
      ? !canCheckForUpdate(updateState)
      : isDesktopUpdateButtonDisabled(updateState));

  const buttonLabel =
    action === "install"
      ? "Restart to update"
      : action === "download"
        ? label
        : downloading
          ? typeof updateState?.downloadPercent === "number"
            ? `Downloading (${Math.floor(updateState.downloadPercent)}%)`
            : "Downloading…"
          : checking
            ? "Checking…"
            : label;

  const handleClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge) return;

    if (action === "download") {
      downloadDesktopUpdate();
      return;
    }

    if (action === "install") {
      const confirmed = window.confirm(
        getDesktopUpdateInstallConfirmationMessage(
          updateState ?? { availableVersion: null, downloadedVersion: null },
          navigator.platform,
        ),
      );
      if (!confirmed) return;
      void bridge
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
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            }),
          );
        });
      return;
    }

    void checkThenDownloadDesktopUpdate(updateState?.checkedAt ?? null);
  }, [action, updateState]);

  if (!isElectron) {
    return (
      <span className="text-muted-foreground text-xs">
        Update or reload this client to match the server.
      </span>
    );
  }

  if (updatesDisabled) {
    return (
      <span className="text-muted-foreground text-xs">
        Automatic updates are unavailable in this build. Install a newer T3 Code desktop build to
        match the server.
      </span>
    );
  }

  return (
    <Button size="xs" disabled={buttonDisabled} onClick={handleClick}>
      {checking || downloading ? <Spinner className="size-3.5" /> : null}
      {buttonLabel}
    </Button>
  );
}
