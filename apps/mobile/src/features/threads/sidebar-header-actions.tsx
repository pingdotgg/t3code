import { SymbolView } from "../../components/AppSymbol";
import { Pressable, View } from "react-native";

import { useThemeColor } from "../../lib/useThemeColor";

export interface SidebarHeaderActionsProps {
  readonly onOpenSettings: () => void;
}

function FallbackHeaderButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: "gearshape" | "square.and.pencil";
  readonly onPress: () => void;
}) {
  const iconColor = useThemeColor("--color-foreground");

  return (
    <Pressable
      className="size-11 items-center justify-center rounded-full bg-subtle active:opacity-70"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      hitSlop={4}
      onPress={props.onPress}
    >
      <SymbolView name={props.icon} size={18} tintColor={iconColor} type="monochrome" />
    </Pressable>
  );
}

export function SidebarHeaderActions(props: SidebarHeaderActionsProps) {
  return (
    <View className="flex-row items-center gap-0.5">
      <FallbackHeaderButton
        accessibilityLabel="Open settings"
        icon="gearshape"
        onPress={props.onOpenSettings}
      />
    </View>
  );
}
