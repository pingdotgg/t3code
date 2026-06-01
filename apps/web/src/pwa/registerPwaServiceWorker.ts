import { registerSW } from "virtual:pwa-register";

import { isElectron } from "../env";
import {
  setPwaServiceWorkerCheckingForUpdate,
  showPwaServiceWorkerUpdateAvailable,
} from "./serviceWorkerUpdateState";

// How often to ask the browser to re-fetch the service worker and look for a
// newer build while the app is left open.
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

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

      let checkInFlight = false;
      const checkForUpdate = async (): Promise<void> => {
        if (checkInFlight || navigator.onLine === false) {
          return;
        }
        checkInFlight = true;
        setPwaServiceWorkerCheckingForUpdate(true);
        try {
          await registration.update();
        } catch (error) {
          console.warn("PWA service worker update check failed", error);
        } finally {
          checkInFlight = false;
          setPwaServiceWorkerCheckingForUpdate(false);
        }
      };

      window.setInterval(() => {
        void checkForUpdate();
      }, UPDATE_CHECK_INTERVAL_MS);

      // Also re-check whenever the tab regains focus, so a backgrounded app
      // surfaces updates soon after the user returns to it.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
          void checkForUpdate();
        }
      });
    },
  });
}
