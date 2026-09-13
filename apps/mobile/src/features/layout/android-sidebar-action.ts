import type { AndroidHeaderAction } from "../../components/AndroidScreenHeader";

export function createAndroidSidebarAction(input: {
  readonly visible: boolean;
  readonly onPress: () => void;
}): AndroidHeaderAction {
  return {
    accessibilityLabel: input.visible ? "Maximize content" : "Show thread sidebar",
    icon: input.visible ? "arrow.up.left.and.arrow.down.right" : "sidebar.left",
    onPress: input.onPress,
  };
}
