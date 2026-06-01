import { registerSW } from "virtual:pwa-register";

import { isElectron } from "../env";
import { showPwaServiceWorkerUpdateAvailable } from "./serviceWorkerUpdateState";

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
  });
}
