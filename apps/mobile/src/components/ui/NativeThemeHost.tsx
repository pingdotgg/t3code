import { Host } from "@expo/ui/swift-ui";
import type { ComponentProps } from "react";
import { useInterfaceDirection } from "../../i18n/direction";
import { useControlTheme } from "./useControlTheme";

export function NativeThemeHost(
  props: Omit<ComponentProps<typeof Host>, "colorScheme" | "seedColor">,
) {
  const direction = useInterfaceDirection();
  const { colors, colorScheme } = useControlTheme();
  const layoutDirection =
    props.layoutDirection ?? (direction === "rtl" ? "rightToLeft" : "leftToRight");
  return (
    <Host
      {...props}
      layoutDirection={layoutDirection}
      colorScheme={colorScheme}
      seedColor={colors["--color-primary"]}
    />
  );
}
