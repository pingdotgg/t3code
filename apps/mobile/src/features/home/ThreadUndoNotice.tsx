import { useState } from "react";
import { useKeyboardState } from "react-native-keyboard-controller";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Toast } from "../../components/ui/Toast";
import {
  useDeviceType,
  useDuoBottomBarInset,
  useNativeLayoutMetrics,
  useNativeColumnLayoutMetrics,
} from "../../native/native-layout-metrics";
import { workspaceSearchBottomClearance } from "../workspace/workspace-tabs-state";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import {
  dismissThreadUndoNotice,
  readThreadUndoNotice,
  useThreadUndoNotice,
} from "./thread-undo-notice";

export function ThreadUndoNotice(props: { readonly visible: boolean }) {
  const notice = useThreadUndoNotice();
  const insets = useSafeAreaInsets();
  const columnMetrics = useNativeColumnLayoutMetrics();
  const rootMetrics = useNativeLayoutMetrics();
  const workspace = useWorkspaceTabs();
  const deviceType = useDeviceType();
  const keyboardHeight = useKeyboardState((keyboard) => keyboard.height);
  const horizontalInsets =
    Platform.OS === "ios"
      ? deviceType === "phone"
        ? { left: 29, right: 23 }
        : { left: 20, right: 20 }
      : { left: 12, right: 12 };
  // The Duo's native tab pill extends above the 48-point toolbar reservation.
  const workspacePadding =
    useDuoBottomBarInset() === undefined
      ? deviceType === "phone" && keyboardHeight === 0
        ? 32
        : 16
      : 8;
  // Replacing a notice must also cancel the native gesture tracking the old one.
  const [instance, setInstance] = useState({ notice, key: 0 });
  if (instance.notice !== notice) setInstance({ notice, key: instance.key + 1 });
  if (!props.visible || notice === null) return null;
  const foldedResting =
    rootMetrics?.hasHinge &&
    rootMetrics.horizontalSizeClass === "compact" &&
    workspace?.state.tabs.threads.searchMode === "resting";
  const bottom =
    Platform.OS === "ios"
      ? foldedResting
        ? Math.max(rootMetrics.safeArea.bottom, keyboardHeight) + 8
        : rootMetrics?.hasHinge && rootMetrics.verticalBarEdge !== "none"
          ? // The column's safe area already includes UIKit's search toolbar in this posture.
            workspaceSearchBottomClearance({
              bottomInset: rootMetrics.safeArea.bottom,
              bottomBarInset: rootMetrics.bottomBarInset,
              keyboardHeight,
            }) -
            16 +
            8
          : Math.max(
              insets.bottom,
              columnMetrics?.safeArea.bottom ?? 0,
              (workspace?.bottomClearance ?? 0) - workspacePadding,
            ) + 8
      : insets.bottom + 12;
  return (
    <View
      key={instance.key}
      collapsable={false}
      className="absolute z-[100]"
      style={{ bottom, ...horizontalInsets }}
      pointerEvents="box-none"
    >
      <Toast
        message={`${notice.action} thread`}
        action={{
          label: "Undo",
          onPress: () => {
            void notice.undo();
          },
        }}
        dismissMode="swipe"
        onDismiss={() => {
          // A newer action can replace the notice while the swipe is animating out.
          if (readThreadUndoNotice() === notice) dismissThreadUndoNotice();
        }}
      />
    </View>
  );
}
