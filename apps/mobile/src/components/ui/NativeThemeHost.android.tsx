import { Host } from "@expo/ui/jetpack-compose";
import { type ComponentProps } from "react";
import { createNativeThemeColors } from "../../lib/nativeTheme";
import { useControlTheme } from "./useControlTheme";

/** One native island, using T3's resolved colors or the user's Material You palette. */
export function NativeThemeHost(
  props: Omit<ComponentProps<typeof Host>, "colorScheme" | "seedColor" | "colorOverrides">,
) {
  const { colors, colorScheme, systemColorsActive } = useControlTheme();
  const colorOverrides = systemColorsActive ? undefined : createNativeThemeColors(colors);
  return <Host {...props} colorScheme={colorScheme} colorOverrides={colorOverrides} />;
}
