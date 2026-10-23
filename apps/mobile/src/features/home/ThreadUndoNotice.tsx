import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Toast } from "../../components/ui/Toast";
import { APP_BAR_HEIGHT } from "../../lib/layoutMetrics";
import { dismissThreadUndoNotice, useThreadUndoNotice } from "./thread-undo-notice";

export function ThreadUndoNotice(props: { readonly visible: boolean }) {
  const notice = useThreadUndoNotice();
  const insets = useSafeAreaInsets();
  if (!props.visible || notice === null) return null;
  return (
    <View
      className="absolute inset-x-3 z-[100]"
      style={{ top: insets.top + APP_BAR_HEIGHT + 8 }}
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
        onDismiss={dismissThreadUndoNotice}
      />
    </View>
  );
}
