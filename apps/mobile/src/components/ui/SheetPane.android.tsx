import { View } from "react-native";

import type { SheetPaneProps } from "./SheetPane.types";
export type { SheetPaneProps } from "./SheetPane.types";

/** The root of a pane or sheet: the bar's color, so ScreenContent's card reads as set into it. */
export function SheetPane(props: SheetPaneProps) {
  return (
    <View collapsable={false} className="flex-1 bg-header">
      {props.children}
    </View>
  );
}
