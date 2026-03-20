import { useEffect, useSyncExternalStore } from "react";

import { resolveDisplayedAppVersion } from "../appVersion";
import { APP_VERSION } from "../branding";
import { isElectron } from "../env";

const listeners = new Set<() => void>();
let desktopAppVersion: string | null = null;
let desktopAppVersionRequest: Promise<void> | null = null;

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

function getSnapshot(): string | null {
  return desktopAppVersion;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function loadDesktopAppVersion(): Promise<void> {
  if (!isElectron || desktopAppVersionRequest) {
    return;
  }

  const bridge = window.desktopBridge;
  if (!bridge || typeof bridge.getAppVersion !== "function") {
    return;
  }

  desktopAppVersionRequest = bridge
    .getAppVersion()
    .then((version) => {
      if (desktopAppVersion === version) {
        return;
      }

      desktopAppVersion = version;
      emitChange();
    })
    .catch(() => undefined)
    .finally(() => {
      desktopAppVersionRequest = null;
    });

  await desktopAppVersionRequest;
}

export function useAppVersion(): string {
  const runtimeVersion = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    void loadDesktopAppVersion();
  }, []);

  return resolveDisplayedAppVersion({
    buildVersion: APP_VERSION,
    desktopAppVersion: runtimeVersion,
  });
}
