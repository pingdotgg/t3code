import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { T3HeaderButton } from "../../native/T3HeaderButton.android";
import { useThemeColor } from "../../lib/useThemeColor";
import type { SidebarHeaderActionsProps } from "./sidebar-header-actions";

export function SidebarHeaderActions(props: SidebarHeaderActionsProps) {
  const iconColor = useThemeColor("--color-foreground");
  return (
    <View className="h-11 flex-row items-center gap-1">
      <Pressable
        accessibilityLabel="Open pull requests"
        accessibilityRole="button"
        hitSlop={4}
        onPress={props.onOpenPullRequests}
        className="size-11 items-center justify-center rounded-full bg-subtle"
      >
        <SymbolView name="arrow.triangle.pull" size={18} tintColor={iconColor} type="monochrome" />
      </Pressable>
      <T3HeaderButton
        accessibilityLabel="Open settings"
        icon="gearshape"
        onPress={props.onOpenSettings}
      />
    </View>
  );
}
