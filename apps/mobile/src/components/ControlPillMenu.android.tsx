import * as Haptics from "expo-haptics";
import { cloneElement, isValidElement, type ReactElement } from "react";
import { AndroidAnchoredMenu } from "./AndroidAnchoredMenu";
import type { ControlPillMenuProps } from "./ControlPillMenu.types";

/** Uses the same actions as iOS menus, with Android appearance and editor anchoring. */
export function ControlPillMenu(props: ControlPillMenuProps) {
  // Long-press menus keep their child interactive: the child element gets
  // an injected onLongPress (mirroring the iOS context-menu interaction)
  // so its own tap handling still works.
  if (props.shouldOpenOnLongPress && isValidElement(props.children)) {
    const child = props.children as ReactElement<{ onLongPress?: () => void }>;
    return (
      <AndroidAnchoredMenu
        actions={props.actions}
        className={props.className}
        title={props.title}
        style={props.style}
        onPressAction={props.onPressAction}
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
    >
      {props.children}
    </AndroidAnchoredMenu>
  );
}
