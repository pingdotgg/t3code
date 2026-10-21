import { useState } from "react";
import { View } from "react-native";
import { FormSheet } from "react-native-screens";
import { useResolveClassNames } from "uniwind";
import { AndroidSheetHeader } from "./AndroidScreenHeader";
import type { SheetProps } from "./Sheet.types";
export type { SheetProps } from "./Sheet.types";

export function Sheet(props: SheetProps) {
  const containerStyle = useResolveClassNames("bg-sheet");
  const [isOpen, setIsOpen] = useState(true);
  return (
    <FormSheet
      isOpen={isOpen}
      detents={[0.5, 0.9]}
      prefersGrabberVisible
      nativeContainerStyle={containerStyle}
      onDismiss={props.onClose}
      onNativeDismiss={props.onClose}
    >
      {/* Android FormSheet does not bound flex children. Material drags target the first scroll view, so place content before the header. */}
      <View collapsable={false} className="absolute inset-0 flex-col-reverse bg-sheet">
        <View className="flex-1">{props.children}</View>
        <AndroidSheetHeader title={props.title} onBack={() => setIsOpen(false)} />
      </View>
    </FormSheet>
  );
}
