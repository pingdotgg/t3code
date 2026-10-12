import { useId, useState, type ReactNode } from "react";
import { Platform, View } from "react-native";
import { FormSheet, Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import { useResolveClassNames, withUniwind } from "uniwind";

import { AndroidSheetHeader } from "./AndroidScreenHeader";
import { nativeHeaderScrollEdgeEffects } from "../native/StackHeader";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);
const NativeScreen = withUniwind(Screen);
const NativeHeader = withUniwind(ScreenStackHeaderConfig, {
  color: { fromClassName: "tintColorClassName", styleProperty: "accentColor" },
  titleColor: { fromClassName: "titleColorClassName", styleProperty: "accentColor" },
});

/** Native presentation for local context whose owner supplies its dismissal callback. */
export function AppSheet(props: {
  readonly title: string;
  readonly children: ReactNode;
  readonly onClose: () => void;
}) {
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
        {Platform.OS === "ios" ? (
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
        ) : (
          <>
            <AndroidSheetHeader title={props.title} onBack={close} />
            {props.children}
          </>
        )}
      </View>
    </FormSheet>
  );
}
