import { SymbolView } from "expo-symbols";
import { Pressable, StyleSheet, View, useColorScheme } from "react-native";

import { useThemeColor } from "../../lib/useThemeColor";

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
  const iconColor = useThemeColor("--color-foreground");
  const pressedBackgroundColor = useThemeColor("--color-subtle");
  const colorScheme = useColorScheme() === "dark" ? "dark" : "light";
  const idleBackgroundColor =
    colorScheme === "dark" ? "rgba(118,118,128,0.24)" : "rgba(255,255,255,0.72)";
  const borderColor = colorScheme === "dark" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)";

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
