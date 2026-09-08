import { getMaterialColors, isDynamicColorAvailable } from "@expo/ui/jetpack-compose";

import type { MaterialYouPalettes } from "./materialYouPalette";

export const isSystemColorsAvailable = isDynamicColorAvailable;

export function readSystemColorPalettes(): MaterialYouPalettes | null {
  if (!isDynamicColorAvailable) return null;

  return {
    light: getMaterialColors({ scheme: "light" }),
    dark: getMaterialColors({ scheme: "dark" }),
  };
}
