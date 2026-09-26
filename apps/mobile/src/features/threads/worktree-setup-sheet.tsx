import { useState, type ReactElement } from "react";
import { Modal, View } from "react-native";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import { withUniwind } from "uniwind";
import { ContextSheetSize } from "../../components/ContextSheetSize";

const NativeScreen = withUniwind(Screen);
const NativeHeader = withUniwind(ScreenStackHeaderConfig, {
  backgroundColor: { fromClassName: "backgroundColorClassName", styleProperty: "backgroundColor" },
  color: { fromClassName: "tintColorClassName", styleProperty: "accentColor" },
  titleColor: { fromClassName: "titleColorClassName", styleProperty: "accentColor" },
});

export interface WorktreeSetupSheetProps {
  children: ReactElement;
  title: string;
  height: number;
  onClose: () => void;
}

export function WorktreeSetupSheet({ children, height, onClose, title }: WorktreeSetupSheetProps) {
  const [headerHeight, setHeaderHeight] = useState(44);
  return (
    <Modal
      animationType="slide"
      presentationStyle="pageSheet"
      allowSwipeDismissal
      onRequestClose={onClose}
    >
      <View collapsable={false} className="flex-1 bg-sheet-solid">
        <ContextSheetSize height={height + headerHeight} />
        {/* The nested stack supplies UIKit's navigation bar inside the sheet. */}
        <ScreenStack style={{ flex: 1 }}>
          <NativeScreen
            activityState={2}
            enabled
            isNativeStack
            screenId="worktree-setup-details"
            onHeaderHeightChange={(event) => setHeaderHeight(event.nativeEvent.headerHeight)}
            className="flex-1 bg-sheet-solid"
          >
            {children}
            <NativeHeader
              title={title}
              titleColorClassName="accent-foreground"
              tintColorClassName="accent-foreground"
              backgroundColorClassName="bg-sheet-solid"
              hideBackButton
              hideShadow
              translucent={false}
              headerRightBarButtonItems={[
                {
                  type: "button",
                  title: "Done",
                  variant: "done",
                  accessibilityLabel: "Close setup details",
                  identifier: "worktree-setup-done",
                  onPress: onClose,
                },
              ]}
            />
          </NativeScreen>
        </ScreenStack>
      </View>
    </Modal>
  );
}
