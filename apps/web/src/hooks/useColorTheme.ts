import { useEffect } from "react";

import { useAppSettings } from "../appSettings";
import { applyColorTheme } from "../lib/colorThemes";
import { useTheme } from "./useTheme";

export function useColorThemeEffect(): void {
  const { resolvedTheme } = useTheme();
  const { settings } = useAppSettings();
  const { colorThemeId, backgroundImage } = settings;

  useEffect(() => {
    if (resolvedTheme === "dark" && colorThemeId) {
      applyColorTheme(colorThemeId, !!backgroundImage);
    } else {
      applyColorTheme(null);
    }
  }, [resolvedTheme, colorThemeId, backgroundImage]);
}
