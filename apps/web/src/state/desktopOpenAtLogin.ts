import type { DesktopBridge, DesktopOpenAtLoginState } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";

type DesktopOpenAtLoginBridge = {
  readonly getOpenAtLoginState: NonNullable<DesktopBridge["getOpenAtLoginState"]>;
  readonly setOpenAtLogin: NonNullable<DesktopBridge["setOpenAtLogin"]>;
};

function getDesktopOpenAtLoginBridge(): DesktopOpenAtLoginBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = window.desktopBridge;
  const getOpenAtLoginState = bridge?.getOpenAtLoginState;
  const setOpenAtLogin = bridge?.setOpenAtLogin;
  if (typeof getOpenAtLoginState !== "function" || typeof setOpenAtLogin !== "function") {
    return undefined;
  }
  return { getOpenAtLoginState, setOpenAtLogin };
}

export function useDesktopOpenAtLogin(): {
  readonly supported: boolean;
  readonly state: DesktopOpenAtLoginState | null;
  readonly setEnabled: (enabled: boolean) => Promise<void>;
} {
  const [state, setState] = useState<DesktopOpenAtLoginState | null>(null);
  const supported = getDesktopOpenAtLoginBridge() !== undefined;
  const requestIdRef = useRef(0);

  useEffect(() => {
    const bridge = getDesktopOpenAtLoginBridge();
    if (!bridge) return;

    let cancelled = false;
    void bridge
      .getOpenAtLoginState()
      .then((next) => {
        // Don't clobber a toggle that resolved while this initial read was in flight.
        if (!cancelled) setState((current) => current ?? next);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not load open at login",
            description: error instanceof Error ? error.message : "Failed to read the setting.",
          }),
        );
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const setEnabled = useCallback(async (enabled: boolean) => {
    const bridge = getDesktopOpenAtLoginBridge();
    if (!bridge) return;

    const requestId = ++requestIdRef.current;
    setState((current) =>
      current === null ? { enabled, available: true } : { ...current, enabled },
    );
    try {
      const next = await bridge.setOpenAtLogin(enabled);
      if (requestId === requestIdRef.current) setState(next);
    } catch (error: unknown) {
      try {
        const next = await bridge.getOpenAtLoginState();
        if (requestId === requestIdRef.current) setState(next);
      } catch {
        if (requestId === requestIdRef.current) setState(null);
      }
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not update open at login",
          description: error instanceof Error ? error.message : "Failed to update the setting.",
        }),
      );
    }
  }, []);

  return { supported, state, setEnabled };
}
