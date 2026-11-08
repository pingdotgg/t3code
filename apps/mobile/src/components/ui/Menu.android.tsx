import * as Haptics from "expo-haptics";
import { cloneElement, isValidElement, type ReactElement } from "react";
import { AndroidAnchoredMenu } from "./AndroidAnchoredMenu.android";
import type { MenuProps } from "./Menu.types";

export function Menu(props: MenuProps) {
  const accessibility = {
    accessible: props.accessible,
    accessibilityLabel: props.accessibilityLabel,
    accessibilityRole: props.accessibilityRole,
    accessibilityState: props.accessibilityState,
  };
  if (props.shouldOpenOnLongPress && isValidElement(props.children)) {
    const child = props.children as ReactElement<{ onLongPress?: () => void }>;
    return (
      <AndroidAnchoredMenu
        actions={props.actions}
        className={props.className}
        title={props.title}
        style={props.style}
        onPressAction={props.onPressAction}
        {...accessibility}
      >
        {(open) =>
          cloneElement(child, {
            onLongPress: () => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              open();
            },
          })
        }
      </AndroidAnchoredMenu>
    );
  }
  return (
    <AndroidAnchoredMenu
      actions={props.actions}
      className={props.className}
      title={props.title}
      style={props.style}
      onPressAction={props.onPressAction}
      {...accessibility}
    >
      {props.children}
    </AndroidAnchoredMenu>
  );
}
