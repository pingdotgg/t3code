import { Pressable } from "react-native";

import type { PaneListItemProps } from "./PaneListItem.types";
export type { PaneListItemProps } from "./PaneListItem.types";

/** A selectable entry in a pane's navigation list, such as a changed file. */
export function PaneListItem(props: PaneListItemProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected }}
      className={
        props.selected
          ? "mt-1 min-h-12 justify-center rounded-xl bg-subtle-strong px-3 py-2"
          : "mt-1 min-h-12 justify-center rounded-xl px-3 py-2 active:bg-subtle"
      }
      onPress={props.onPress}
    >
      {props.children}
    </Pressable>
  );
}
