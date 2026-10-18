import { Host, ModalBottomSheet, RNHostView } from "@expo/ui/jetpack-compose";
import { View, useWindowDimensions } from "react-native";
import { withUniwind } from "uniwind";
import { AndroidSheetHeader } from "../../components/ui/AndroidScreenHeader";
import type { WorktreeSetupSheetProps } from "./worktree-setup-sheet";

const NativeBottomSheet = withUniwind(ModalBottomSheet, {
  containerColor: { fromClassName: "containerColorClassName", styleProperty: "accentColor" },
});

export function WorktreeSetupSheet({ children, height, onClose }: WorktreeSetupSheetProps) {
  const window = useWindowDimensions();
  return (
    <Host style={{ position: "absolute", width: 0, height: 0 }}>
      <NativeBottomSheet
        onDismissRequest={onClose}
        skipPartiallyExpanded
        containerColorClassName="accent-sheet-solid"
      >
        <RNHostView matchContents>
          <View
            style={{
              width: Math.min(window.width, 640),
              height: Math.min((height || 360) + 64, window.height * 0.85),
            }}
          >
            <AndroidSheetHeader
              title="Worktree setup"
              actions={[
                { accessibilityLabel: "Close setup details", icon: "xmark", onPress: onClose },
              ]}
            />
            {children}
          </View>
        </RNHostView>
      </NativeBottomSheet>
    </Host>
  );
}
