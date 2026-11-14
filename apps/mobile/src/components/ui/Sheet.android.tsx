import { useState } from "react";
import { View } from "react-native";
import { FormSheet } from "react-native-screens";
import { useResolveClassNames } from "uniwind";
import { AppBar } from "./AppBar";
import { BottomSheetContext } from "./BottomSheetContext";
import { RoutedFormSheetContext } from "./RoutedFormSheetContext";
import { ScreenContent } from "./ScreenContent";
import type { SheetProps } from "./Sheet.types";
export type { SheetProps } from "./Sheet.types";

export function Sheet(props: SheetProps) {
  const containerStyle = useResolveClassNames("bg-header");
  const [isOpen, setIsOpen] = useState(true);
  return (
    <FormSheet
      isOpen={isOpen}
      detents={[0.5, 0.9]}
      prefersGrabberVisible={false}
      preventNativeDismiss={props.dismissDisabled}
      nativeContainerStyle={containerStyle}
      onDismiss={props.onClose}
      onNativeDismiss={props.onClose}
    >
      <BottomSheetContext value>
        <RoutedFormSheetContext value={false}>
          {/* Android FormSheet does not bound flex children. */}
          <View collapsable={false} className="absolute inset-0 bg-header">
            <AppBar
              sheet
              title={props.title}
              onBack={props.dismissDisabled ? undefined : () => setIsOpen(false)}
              hideBottomBorder
            />
            <ScreenContent>{props.children}</ScreenContent>
            <View
              pointerEvents="none"
              className="absolute top-1 h-1 w-8 self-center rounded-full bg-header-foreground/40"
            />
          </View>
        </RoutedFormSheetContext>
      </BottomSheetContext>
    </FormSheet>
  );
}
