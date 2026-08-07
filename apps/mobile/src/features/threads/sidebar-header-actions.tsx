import { SymbolView } from "../../components/AppSymbol";
import { Pressable, StyleSheet, View } from "react-native";

import { useThemeColor } from "../../lib/useThemeColor";
import { useAppearanceColorScheme } from "../../lib/useAppearanceColorScheme";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

export interface SidebarHeaderActionsProps {
  readonly onOpenSettings: () => void;
  /** Rendered inside a shared capsule group — buttons drop their own chrome. */
  readonly grouped?: boolean;
}

function FallbackHeaderButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: "gearshape" | "square.and.pencil";
  readonly grouped?: boolean;
  readonly onPress: () => void;
}) {
  const foregroundFallback = useThemeColor("--color-foreground");
  const pressedFallback = useThemeColor("--color-subtle");
  const borderFallback = useThemeColor("--color-border");
  const colorScheme = useAppearanceColorScheme() === "dark" ? "dark" : "light";
  const { themeColors } = useAppearancePreferences();
  const iconColor = themeColors?.sidebarForeground ?? foregroundFallback;
  const pressedBackgroundColor = themeColors?.sidebarRowHover ?? pressedFallback;
  const idleBackgroundColor =
    themeColors?.sidebarControlSurface ??
    (colorScheme === "dark" ? "rgba(118,118,128,0.24)" : "rgba(255,255,255,0.72)");
  const borderColor =
    themeColors?.sidebarBorder ??
    borderFallback ??
    (colorScheme === "dark" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)");

  return (
    <Pressable
      className="h-11 w-[50px] items-center justify-center rounded-[22px]"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      hitSlop={4}
      onPress={props.onPress}
      style={({ pressed }) => [
        props.grouped
          ? { backgroundColor: pressed ? pressedBackgroundColor : "transparent", borderWidth: 0 }
          : {
              backgroundColor: pressed ? pressedBackgroundColor : idleBackgroundColor,
              borderColor,
              borderWidth: StyleSheet.hairlineWidth,
            },
      ]}
    >
      <SymbolView name={props.icon} size={20} tintColor={iconColor} type="monochrome" />
    </Pressable>
  );
}

export function SidebarHeaderActions(props: SidebarHeaderActionsProps) {
  return (
    <View className="flex-row items-center gap-0.5">
      <FallbackHeaderButton
        accessibilityLabel="Open settings"
        grouped={props.grouped}
        icon="gearshape"
        onPress={props.onOpenSettings}
      />
    </View>
  );
}
