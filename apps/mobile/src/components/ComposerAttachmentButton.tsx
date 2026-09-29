import { translate } from "@t3tools/i18n";
import type { MenuAction } from "@react-native-menu/menu";
import { Pressable } from "react-native";

import { useAndroidControlSizing } from "./useAndroidControlSizing";
import { SymbolView } from "./AppSymbol";
import { ControlPillMenu } from "./ControlPill";

export function ComposerAttachmentButton(props: {
  readonly disabled?: boolean;
  readonly supportsFiles: boolean;
  readonly onPickMedia: () => Promise<void>;
  readonly onPickFiles: () => Promise<void>;
}) {
  const { scale } = useAndroidControlSizing();
  const attachmentMenuActions: MenuAction[] = [
    {
      id: "photos",
      title: translate("common:mobileComposer.photoLibrary", "Photo Library"),
      image: "photo",
    },
    {
      id: "files",
      title: translate("common:mobileComposer.chooseFiles", "Choose Files"),
      image: "folder",
    },
  ];
  const button = (
    <Pressable
      accessibilityLabel={translate("common:mobileAddAttachment", "Add attachment")}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      className="size-[44px] shrink-0 items-center justify-center rounded-full active:opacity-70 disabled:opacity-50"
      disabled={props.disabled}
      onPress={props.supportsFiles ? undefined : () => void props.onPickMedia()}
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

  if (props.disabled || !props.supportsFiles) {
    return button;
  }

  return (
    <ControlPillMenu
      accessible
      accessibilityLabel={translate("common:mobileAddAttachment", "Add attachment")}
      accessibilityRole="button"
      actions={attachmentMenuActions}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "photos") {
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
