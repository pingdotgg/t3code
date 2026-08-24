import type { PickedThemeFile } from "@t3tools/contracts";
import { useEffect } from "react";

import { useTheme } from "../hooks/useTheme";
import {
  getCustomThemes,
  installCustomTheme,
  parseThemeFile,
  updateCustomTheme,
} from "../themePalette";
import { isVsCodeThemeFile, parseVsCodeThemeFile } from "../vscodeThemeImport";

export function importDesktopThemeFile(file: PickedThemeFile): string {
  if (!file.text) throw new Error(`Could not read theme file "${file.name}".`);
  const value: unknown = JSON.parse(file.text);
  const theme = isVsCodeThemeFile(value) ? parseVsCodeThemeFile(value) : parseThemeFile(value);
  if (getCustomThemes().some((installed) => installed.id === theme.id)) {
    updateCustomTheme(theme);
  } else {
    installCustomTheme(theme);
  }
  return theme.id;
}

export function DesktopThemeFileCommands() {
  const { setTheme } = useTheme();

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.onThemeFileApply) return;
    return bridge.onThemeFileApply((file) => {
      try {
        const themeId = importDesktopThemeFile(file);
        if (!setTheme(themeId)) throw new Error(`Could not activate theme "${themeId}".`);
      } catch (cause) {
        console.error("Failed to apply desktop theme file.", { file: file.name, cause });
      }
    });
  }, [setTheme]);

  return null;
}
