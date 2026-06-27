import { View } from "react-native";

import { T3HeaderButton } from "../../native/T3HeaderButton.ios";
import type { SidebarHeaderActionsProps } from "./sidebar-header-actions";

export function SidebarHeaderActions(props: SidebarHeaderActionsProps) {
  return (
    <View style={{ height: 44, flexDirection: "row", gap: 8 }}>
      <T3HeaderButton
        accessibilityLabel="Open settings"
        icon="gearshape"
        onPress={props.onOpenSettings}
      />
      <T3HeaderButton
        accessibilityLabel="New task"
        icon="square.and.pencil"
        onPress={props.onStartNewTask}
      />
    </View>
  );
}
