import type { ThreadTitleMenuTrigger as IosTrigger } from "./ThreadTitleMenuTrigger";
import { Pressable } from "react-native";
import { AndroidAnchoredMenu } from "../../components/ui/AndroidAnchoredMenu";

export function ThreadTitleMenuTrigger(props: Parameters<typeof IosTrigger>[0]) {
  return (
    <AndroidAnchoredMenu
      actions={props.actions}
      title={props.title}
      onPressAction={({ nativeEvent }) => props.onAction(nativeEvent.event)}
    >
      {(open) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Thread actions for ${props.title}`}
          onPressIn={props.onOpen}
          onPress={open}
          onLongPress={open}
          className="min-h-11 min-w-0 justify-center"
        >
          {props.children}
        </Pressable>
      )}
    </AndroidAnchoredMenu>
  );
}
