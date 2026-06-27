import { SymbolView } from "expo-symbols";
import { Pressable, StyleSheet, View } from "react-native";

import { useThemeColor } from "../../lib/useThemeColor";

export interface SidebarHeaderActionsProps {
  readonly onOpenSettings: () => void;
  readonly onStartNewTask: () => void;
}

function FallbackHeaderButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: "gearshape" | "square.and.pencil";
  readonly onPress: () => void;
}) {
  const iconColor = useThemeColor("--color-icon-muted");
  const pressedBackgroundColor = useThemeColor("--color-subtle");

  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      hitSlop={4}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: pressed ? pressedBackgroundColor : "transparent" },
      ]}
    >
      <SymbolView name={props.icon} size={18} tintColor={iconColor} type="monochrome" />
    </Pressable>
  );
}

export function SidebarHeaderActions(props: SidebarHeaderActionsProps) {
  return (
    <View style={styles.actions}>
      <FallbackHeaderButton
        accessibilityLabel="Open settings"
        icon="gearshape"
        onPress={props.onOpenSettings}
      />
      <FallbackHeaderButton
        accessibilityLabel="New task"
        icon="square.and.pencil"
        onPress={props.onStartNewTask}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  button: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
});
