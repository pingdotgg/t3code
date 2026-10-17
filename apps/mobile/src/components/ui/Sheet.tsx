import { useId, useState } from "react";
import { Platform, View } from "react-native";
import { FormSheet, ScreenStack } from "react-native-screens";
import { useResolveClassNames } from "uniwind";

import { nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { NativeHeader, NativeScreen } from "../../native/ThemedScreenStack";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

export type { SheetProps } from "./Sheet.types";
import type { SheetProps } from "./Sheet.types";

/** Native presentation. Scrollable children use automatic insets beneath the iOS header. */
export function Sheet(props: SheetProps) {
  const containerStyle = useResolveClassNames("bg-sheet");
  const screenId = useId();
  const [isOpen, setIsOpen] = useState(true);
  const close = () => setIsOpen(false);

  return (
    <FormSheet
      isOpen={isOpen}
      detents={[0.5, 0.9]}
      prefersGrabberVisible
      nativeContainerStyle={containerStyle}
      onDismiss={props.onClose}
      onNativeDismiss={props.onClose}
    >
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <NativeScreen
            activityState={2}
            enabled
            isNativeStack
            screenId={`app-sheet-${screenId}`}
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            className="flex-1 bg-sheet"
          >
            {props.children}
            <NativeHeader
              backgroundColor="rgba(0,0,0,0)"
              tintColorClassName="accent-foreground"
              hideBackButton
              hideShadow={false}
              title={props.title}
              titleColorClassName="accent-foreground"
              titleFontSize={18}
              titleFontWeight="800"
              translucent
              headerRightBarButtonItems={[
                {
                  type: "button",
                  title: "Done",
                  variant: "done",
                  accessibilityLabel: `Close ${props.title}`,
                  identifier: `app-sheet-done-${screenId}`,
                  onPress: close,
                },
              ]}
            />
          </NativeScreen>
        </ScreenStack>
      </View>
    </FormSheet>
  );
}
