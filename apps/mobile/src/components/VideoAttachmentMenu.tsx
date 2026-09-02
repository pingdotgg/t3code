import type { ReactElement } from "react";
import { Platform, type PressableProps } from "react-native";

import { ControlPillMenu } from "./ControlPill";
import { PresentationSource } from "./NativePresentation";

export function VideoAttachmentMenu(props: {
  readonly sourceIdentifier: string;
  readonly onOpen: () => void;
  readonly onShare?: () => void;
  readonly disabled?: boolean;
  readonly children: ReactElement<PressableProps>;
}) {
  return (
    <PresentationSource
      identifier={props.sourceIdentifier}
      accessible={Platform.OS === "ios"}
      accessibilityRole="button"
      accessibilityLabel={props.children.props.accessibilityLabel}
      accessibilityHint={props.children.props.accessibilityHint}
      accessibilityState={{ disabled: props.disabled ?? false }}
      onAccessibilityTap={() => {
        if (!props.disabled) props.onOpen();
      }}
      accessibilityActions={props.onShare ? [{ name: "share", label: "Save or share video" }] : []}
      onAccessibilityAction={({ nativeEvent }) => {
        if (nativeEvent.actionName === "share" && !props.disabled) props.onShare?.();
      }}
    >
      {Platform.OS === "ios" && props.onShare ? (
        <ControlPillMenu
          shouldOpenOnLongPress
          style={{ alignSelf: "flex-start" }}
          actions={[
            {
              id: "share",
              title: "Save or share video",
              image: "square.and.arrow.up",
              attributes: { disabled: props.disabled ?? false },
            },
          ]}
          onPressAction={({ nativeEvent }) => {
            if (nativeEvent.event === "share") props.onShare?.();
          }}
        >
          {props.children}
        </ControlPillMenu>
      ) : (
        props.children
      )}
    </PresentationSource>
  );
}
