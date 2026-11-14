import { View } from "react-native";
import { FormSheet } from "react-native-screens";
import { useResolveClassNames } from "uniwind";

import { BottomSheetContext } from "./BottomSheetContext";
import type { PaneSheetProps } from "./PaneSheet.types";
export type { PaneSheetProps } from "./PaneSheet.types";

/** A native sheet holding a pane that draws its own bar, which runs up under the drawn grabber. */
export function PaneSheet({ children, ...props }: PaneSheetProps) {
  const containerStyle = useResolveClassNames("bg-header");
  return (
    <FormSheet {...props} preferredCornerRadius={28} nativeContainerStyle={containerStyle}>
      <BottomSheetContext value>
        {/* Android FormSheet does not bound flex children. */}
        <View collapsable={false} className="absolute inset-0 bg-header pt-3">
          {children}
          <View
            pointerEvents="none"
            className="absolute top-1 h-1 w-8 self-center rounded-full bg-header-foreground/40"
          />
        </View>
      </BottomSheetContext>
    </FormSheet>
  );
}
