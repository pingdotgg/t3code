import { registerSW } from "virtual:pwa-register";

import { isElectron } from "../env";
import {
  setPwaServiceWorkerUpdateCheckPhase,
  showPwaServiceWorkerUpdateAvailable,
} from "./serviceWorkerUpdateState";
import { clearTurnCompletionAlerts } from "../push/notifications";

// How often to ask the browser to re-fetch the service worker and look for a
// newer build while the app is left open.
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const UPDATE_INSTALL_WAIT_TIMEOUT_MS = 60_000;

function waitForServiceWorkerInstalled(worker: ServiceWorker): Promise<void> {
  return new Promise((resolve) => {
    if (worker.state !== "installing") {
      resolve();
      return;
    }

    let timeoutId: number | undefined;

    const cleanup = () => {
      worker.removeEventListener("statechange", handleStateChange);
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };

    const finish = () => {
      cleanup();
      resolve();
    };

    const handleStateChange = () => {
      if (worker.state !== "installing") {
        finish();
      }
    };

    worker.addEventListener("statechange", handleStateChange);
    if (worker.state !== "installing") {
      finish();
      return;
    }
    timeoutId = window.setTimeout(finish, UPDATE_INSTALL_WAIT_TIMEOUT_MS);
  });
}

export function registerPwaServiceWorker(): void {
  if (
    isElectron ||
    typeof window === "undefined" ||
    !window.isSecureContext ||
    !("serviceWorker" in navigator)
  ) {
    return;
  }

  const updateServiceWorker = registerSW({
    immediate: true,
    onNeedRefresh() {
      showPwaServiceWorkerUpdateAvailable(updateServiceWorker);
    },
    onRegisterError(error) {
      console.warn("PWA service worker registration failed", error);
    },
    onRegisteredSW(_swScriptUrl, registration) {
      if (!registration) {
        return;
      }
      void clearTurnCompletionAlerts(registration);

      let checkInFlight = false;
      const checkForUpdate = async (): Promise<void> => {
        if (checkInFlight || navigator.onLine === false) {
          return;
        }
        checkInFlight = true;
        setPwaServiceWorkerUpdateCheckPhase("checking");
        try {
          await registration.update();
          const installingWorker = registration.installing;
          if (installingWorker) {
            setPwaServiceWorkerUpdateCheckPhase("downloading");
            await waitForServiceWorkerInstalled(installingWorker);
          }
        } catch (error) {
          console.warn("PWA service worker update check failed", error);
        } finally {
          checkInFlight = false;
          setPwaServiceWorkerUpdateCheckPhase("idle");
        }
      };

      window.setInterval(() => {
        void checkForUpdate();
      }, UPDATE_CHECK_INTERVAL_MS);

      // Also re-check whenever the tab regains focus, so a backgrounded app
      // surfaces updates soon after the user returns to it.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
          void clearTurnCompletionAlerts(registration);
          void checkForUpdate();
        }
      });

      void checkForUpdate();
    },
  });
}
