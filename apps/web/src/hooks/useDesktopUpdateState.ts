import { useEffect, useState } from "react";
import type { DesktopUpdateState } from "@t3tools/contracts";

import { APP_VERSION } from "../branding";
import { isElectron } from "../env";

interface ResolveDisplayedAppVersionInput {
  readonly desktopUpdateState: DesktopUpdateState | null;
  readonly fallbackVersion?: string;
  readonly isDesktopRuntime: boolean;
}

export function resolveDisplayedAppVersion({
  desktopUpdateState,
  fallbackVersion = APP_VERSION,
  isDesktopRuntime,
}: ResolveDisplayedAppVersionInput): string {
  if (!isDesktopRuntime) {
    return fallbackVersion;
  }

  const runtimeVersion = desktopUpdateState?.currentVersion.trim();
  return runtimeVersion && runtimeVersion.length > 0 ? runtimeVersion : fallbackVersion;
}

export function useDesktopUpdateState(): DesktopUpdateState | null {
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);

  useEffect(() => {
    if (!isElectron) return;
    const bridge = window.desktopBridge;
    if (
      !bridge ||
      typeof bridge.getUpdateState !== "function" ||
      typeof bridge.onUpdateState !== "function"
    ) {
      return;
    }

    let disposed = false;
    let receivedSubscriptionUpdate = false;
    const unsubscribe = bridge.onUpdateState((nextState) => {
      if (disposed) return;
      receivedSubscriptionUpdate = true;
      setDesktopUpdateState(nextState);
    });

    void bridge
      .getUpdateState()
      .then((nextState) => {
        if (disposed || receivedSubscriptionUpdate) return;
        setDesktopUpdateState(nextState);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  return desktopUpdateState;
}
