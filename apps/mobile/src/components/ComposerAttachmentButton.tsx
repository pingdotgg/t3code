import type { MenuAction } from "@react-native-menu/menu";
import { Pressable } from "react-native";

import { SymbolView } from "./AppSymbol";
import { ControlPillMenu } from "./ControlPill";

const ATTACHMENT_MENU_ACTIONS: MenuAction[] = [
  { id: "camera", title: "Take Photo", image: "camera" },
  { id: "photos", title: "Photo Library", image: "photo" },
  { id: "files", title: "Choose Files", image: "folder" },
];

const MEDIA_ATTACHMENT_MENU_ACTIONS = ATTACHMENT_MENU_ACTIONS.filter(
  (action) => action.id !== "files",
);

/** Renders the shared camera, library, and optional file actions for a composer. */
export function ComposerAttachmentButton(props: {
  readonly disabled?: boolean;
  readonly supportsFiles: boolean;
  readonly onTakePhoto: () => Promise<void>;
  readonly onPickMedia: () => Promise<void>;
  readonly onPickFiles: () => Promise<void>;
}) {
  const button = (
    <Pressable
      accessibilityLabel="Add attachment"
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      className="size-[44px] shrink-0 items-center justify-center rounded-full active:opacity-70 disabled:opacity-50"
      disabled={props.disabled}
    >
      <SymbolView
        name="plus"
        size={20}
        weight="regular"
        tintColorClassName="accent-icon"
        type="monochrome"
      />
    </Pressable>
  );

  if (props.disabled) {
    return button;
  }

  return (
    <ControlPillMenu
      accessible
      accessibilityLabel="Add attachment"
      accessibilityRole="button"
      actions={props.supportsFiles ? ATTACHMENT_MENU_ACTIONS : MEDIA_ATTACHMENT_MENU_ACTIONS}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "camera") {
          void props.onTakePhoto();
        } else if (nativeEvent.event === "photos") {
          void props.onPickMedia();
        } else if (nativeEvent.event === "files") {
          void props.onPickFiles();
        }
      }}
    >
      {button}
    </ControlPillMenu>
  );
}
