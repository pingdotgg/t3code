import { View } from "react-native";
import { FormSheet } from "react-native-screens";
import { useResolveClassNames } from "uniwind";

import { BottomSheetContext } from "./BottomSheetContext";
import type { PaneSheetProps } from "./PaneSheet.types";
export type { PaneSheetProps } from "./PaneSheet.types";

/** A native sheet holding a pane that draws its own bar. */
export function PaneSheet({ children, ...props }: PaneSheetProps) {
  const containerStyle = useResolveClassNames("bg-sheet");
  return (
    <FormSheet {...props} prefersGrabberVisible nativeContainerStyle={containerStyle}>
      <BottomSheetContext value>
        <View collapsable={false} className="flex-1 bg-sheet">
          {children}
        </View>
      </BottomSheetContext>
    </FormSheet>
  );
}
