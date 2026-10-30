import type { DesktopRemotePreviewProxyStatus, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

/** The desktop proxy's status for an environment, or null when it has none. */
export function useRemotePreviewProxyStatus(
  environmentId: EnvironmentId,
  enabled: boolean,
): DesktopRemotePreviewProxyStatus | null {
  const [status, setStatus] = useState<DesktopRemotePreviewProxyStatus | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors status owned by the desktop main process
  useEffect(() => {
    const bridge = window.desktopBridge?.preview?.remoteProxy;
    if (!enabled || !bridge) return;
    let disposed = false;
    const unsubscribe = bridge.onStatus((next) => {
      if (next.environmentId === environmentId) setStatus(next);
    });
    void bridge
      .getStatus(environmentId)
      .then((initial) => {
        if (disposed) return;
        setStatus((current) => (current?.environmentId === environmentId ? current : initial));
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [enabled, environmentId]);
  return enabled && status?.environmentId === environmentId ? status : null;
}
