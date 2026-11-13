import { Host } from "@expo/ui/swift-ui";
import type { ComponentProps } from "react";
import { useControlTheme } from "./useControlTheme";

export function NativeThemeHost(
  props: Omit<ComponentProps<typeof Host>, "colorScheme" | "seedColor">,
) {
  const { colors, colorScheme } = useControlTheme();
  return <Host {...props} colorScheme={colorScheme} seedColor={colors["--color-primary"]} />;
}
