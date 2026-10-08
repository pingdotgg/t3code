import type { MenuAction } from "@react-native-menu/menu";
import { Pressable } from "react-native";

import { useAndroidControlSizing } from "./useAndroidControlSizing";
import { SymbolView } from "./AppSymbol";
import { ControlPillMenu } from "./ControlPill";

const ATTACHMENT_MENU_ACTIONS: MenuAction[] = [
  { id: "photos", title: "Photo Library", image: "photo" },
  { id: "files", title: "Choose Files", image: "folder" },
  { id: "location", title: "Location", image: "location" },
];

export function ComposerAttachmentButton(props: {
  readonly disabled?: boolean;
  readonly supportsFiles: boolean;
  readonly onPickMedia: () => Promise<void>;
  readonly onPickFiles: () => Promise<void>;
  readonly onPickLocation?: () => Promise<void>;
}) {
  const { scale } = useAndroidControlSizing();
  const button = (
    <Pressable
      accessibilityLabel="Add attachment"
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      className="size-[44px] shrink-0 items-center justify-center rounded-full active:opacity-70 disabled:opacity-50"
      disabled={props.disabled}
      onPress={
        props.supportsFiles || props.onPickLocation ? undefined : () => void props.onPickMedia()
      }
    >
      <SymbolView
        name="plus"
        size={Math.round(20 * scale)}
        weight="regular"
        tintColorClassName="accent-icon"
        type="monochrome"
      />
    </Pressable>
  );

  if (props.disabled || (!props.supportsFiles && !props.onPickLocation)) {
    return button;
  }

  return (
    <ControlPillMenu
      accessible
      accessibilityLabel="Add attachment"
      accessibilityRole="button"
      actions={ATTACHMENT_MENU_ACTIONS.filter((action) =>
        action.id === "files"
          ? props.supportsFiles
          : action.id === "location"
            ? props.onPickLocation !== undefined
            : true,
      )}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "photos") {
          void props.onPickMedia();
        } else if (nativeEvent.event === "files") {
          void props.onPickFiles();
        } else if (nativeEvent.event === "location") {
          void props.onPickLocation?.();
        }
      }}
    >
      {button}
    </ControlPillMenu>
  );
}
