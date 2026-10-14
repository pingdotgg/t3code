import type { DesktopLocalThemeState } from "@t3tools/contracts";
import { useEffect } from "react";
import { applyDesktopThemeState } from "../desktopTheme";
import { useTheme } from "./useTheme";

export function useDesktopLocalThemeSync(): void {
  const { refreshTheme } = useTheme();
  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.getLocalTheme || !bridge.onLocalTheme) return;
    let active = true;
    let eventReceived = false;
    const apply = (state: DesktopLocalThemeState) => {
      if (active && applyDesktopThemeState(state)) refreshTheme({ preservePreview: true });
    };
    const unsubscribe = bridge.onLocalTheme((state) => {
      eventReceived = true;
      apply(state);
    });
    void bridge
      .getLocalTheme()
      .then((state) => {
        if (!eventReceived) apply(state);
      })
      .catch(() => {
        // Older or unavailable desktop bridges leave the saved palette intact.
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [refreshTheme]);
}
