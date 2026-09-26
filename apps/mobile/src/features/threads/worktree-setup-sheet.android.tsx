import { Host, ModalBottomSheet, RNHostView } from "@expo/ui/jetpack-compose";
import { Pressable, View, useWindowDimensions } from "react-native";
import { withUniwind } from "uniwind";
import { AndroidSheetHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import type { WorktreeSetupSheetProps } from "./worktree-setup-sheet";

const NativeBottomSheet = withUniwind(ModalBottomSheet, {
  containerColor: { fromClassName: "containerColorClassName", styleProperty: "accentColor" },
});

export function WorktreeSetupSheet({ children, height, onClose, title }: WorktreeSetupSheetProps) {
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
              title={title}
              trailing={
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Close setup details"
                  onPress={onClose}
                  className="min-h-11 justify-center px-2"
                >
                  <Text className="font-t3-medium text-sm text-foreground">Done</Text>
                </Pressable>
              }
            />
            {children}
          </View>
        </RNHostView>
      </NativeBottomSheet>
    </Host>
  );
}
