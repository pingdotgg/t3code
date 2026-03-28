import type { DesktopWindowState } from "@t3tools/contracts";
import { useEffect, useState } from "react";

export function useDesktopWindowState(): DesktopWindowState | null {
  const [windowState, setWindowState] = useState<DesktopWindowState | null>(null);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge) {
      setWindowState(null);
      return;
    }

    let cancelled = false;
    let receivedSubscriptionState = false;

    const unsubscribe = bridge.onWindowState((nextState) => {
      if (!cancelled) {
        receivedSubscriptionState = true;
        setWindowState(nextState);
      }
    });

    void bridge.getWindowState().then((nextState) => {
      if (!cancelled && !receivedSubscriptionState) {
        setWindowState(nextState);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return windowState;
}
