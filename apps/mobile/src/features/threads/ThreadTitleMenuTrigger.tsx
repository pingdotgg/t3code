import type { MenuAction } from "@react-native-menu/menu";
import type { ReactNode } from "react";
import { View } from "react-native";
import { Menu } from "../../components/ui/Menu";

export function ThreadTitleMenuTrigger(props: {
  readonly actions: MenuAction[];
  readonly title: string;
  readonly maxWidth: number;
  readonly onOpen: () => void;
  readonly onAction: (id: string) => void;
  readonly children: ReactNode;
}) {
  return (
    <Menu
      style={{ maxWidth: props.maxWidth, flexShrink: 1 }}
      actions={props.actions}
      title={props.title}
      onMenuInteractionStart={props.onOpen}
      onPressAction={({ nativeEvent }) => props.onAction(nativeEvent.event)}
      accessibilityRole="button"
      accessibilityLabel={`Thread actions for ${props.title}`}
    >
      <View className="min-h-11 min-w-0 justify-center">{props.children}</View>
    </Menu>
  );
}
