import { Host } from "@expo/ui/jetpack-compose";
import { type ComponentProps } from "react";
import { useInterfaceDirection } from "../../i18n/direction";
import { createNativeThemeColors } from "../../lib/nativeTheme";
import { useControlTheme } from "./useControlTheme";

export function NativeThemeHost(
  props: Omit<ComponentProps<typeof Host>, "colorScheme" | "seedColor" | "colorOverrides">,
) {
  const direction = useInterfaceDirection();
  const { colors, colorScheme, systemColorsActive } = useControlTheme();
  const colorOverrides = systemColorsActive ? undefined : createNativeThemeColors(colors);
  const layoutDirection =
    props.layoutDirection ?? (direction === "rtl" ? "rightToLeft" : "leftToRight");
  return (
    <Host
      {...props}
      layoutDirection={layoutDirection}
      colorScheme={colorScheme}
      colorOverrides={colorOverrides}
    />
  );
}
