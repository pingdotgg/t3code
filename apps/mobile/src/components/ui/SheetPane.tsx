import { View } from "react-native";

import type { SheetPaneProps } from "./SheetPane.types";
export type { SheetPaneProps } from "./SheetPane.types";

/** The root of a pane or sheet that draws an AppBar above its ScreenContent. */
export function SheetPane(props: SheetPaneProps) {
  return (
    <View
      collapsable={false}
      className={props.surface === "screen" ? "flex-1 bg-screen" : "flex-1 bg-sheet"}
    >
      {props.children}
    </View>
  );
}
