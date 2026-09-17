import { MenuView } from "@react-native-menu/menu";
import type { ReactElement } from "react";
import { Platform, View, type PressableProps, type StyleProp, type ViewStyle } from "react-native";

import type { useMediaActions } from "../lib/mediaActions";
import { SymbolView } from "./AppSymbol";
import { ControlPillMenu } from "./ControlPill";

export function MediaActionsMenu(props: {
  readonly media: ReturnType<typeof useMediaActions>;
  readonly inModal?: boolean;
  readonly children?: ReactElement<PressableProps>;
  readonly style?: StyleProp<ViewStyle>;
}) {
  if (props.media.actions.length === 0) return props.children ?? null;
  // Android's normal anchored menu lives in the app-root portal, behind native modals.
  const nativeAndroidMenu = props.inModal && Platform.OS === "android";
  const Menu = nativeAndroidMenu ? MenuView : ControlPillMenu;
  return (
    <Menu
      title={props.media.title}
      style={props.style}
      shouldOpenOnLongPress={props.children !== undefined}
      actions={props.media.actions.map(({ id, title, disabled }) => ({
        id,
        title,
        attributes: { disabled: disabled ?? false },
      }))}
      onPressAction={({ nativeEvent }) => {
        props.media.actions.find(({ id }) => id === nativeEvent.event)?.run();
      }}
    >
      {props.children ?? (
        <View
          accessible
          accessibilityRole="button"
          accessibilityLabel="Media actions"
          className="min-h-11 min-w-11 items-center justify-center rounded-md bg-black/60"
        >
          <SymbolView name="ellipsis" size={20} tintColor="#ffffff" type="monochrome" />
        </View>
      )}
    </Menu>
  );
}
