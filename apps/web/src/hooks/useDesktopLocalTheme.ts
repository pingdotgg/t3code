import type { DesktopLocalThemeState } from "@t3tools/contracts";
import { useEffect } from "react";
import {
  DESKTOP_LOCAL_THEME_ID,
  setDesktopLocalTheme,
  setDesktopLocalThemeSource,
  getManualThemeSelectionRevision,
} from "../themePalette";
import { environmentThemeDefinition } from "../publishedTheme";
import { useTheme } from "./useTheme";

export function useDesktopLocalThemeSync(): void {
  const { refreshTheme } = useTheme();
  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.getLocalTheme || !bridge.onLocalTheme) return;
    setDesktopLocalThemeSource("loading");
    const startupSelection = getManualThemeSelectionRevision();
    let active = true;
    let eventReceived = false;
    const apply = (state: DesktopLocalThemeState) => {
      if (!active) return;
      setDesktopLocalThemeSource(state.enabled ? "configured" : "unavailable");
      const theme = state.theme;
      const definition =
        theme === null
          ? null
          : environmentThemeDefinition({ ...theme, id: DESKTOP_LOCAL_THEME_ID });
      if (setDesktopLocalTheme(definition)) refreshTheme({ preservePreview: true });
    };
    const unsubscribe = bridge.onLocalTheme((theme) => {
      eventReceived = true;
      apply(theme);
    });
    void bridge
      .getLocalTheme()
      .then((theme) => {
        if (!active || eventReceived) return;
        if (startupSelection === getManualThemeSelectionRevision()) apply(theme);
        else setDesktopLocalThemeSource(theme.enabled ? "configured" : "unavailable");
      })
      .catch(() => {
        if (active) setDesktopLocalThemeSource("unavailable");
      });
    return () => {
      active = false;
      unsubscribe();
      setDesktopLocalThemeSource("unavailable");
      if (setDesktopLocalTheme(null)) refreshTheme({ preservePreview: true });
    };
  }, [refreshTheme]);
}
