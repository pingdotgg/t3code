import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Toast } from "../../components/ui/Toast";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { dismissComposerInsertNotice, useComposerInsertNotice } from "./composer-insert-notice";

/** Confirms a comment reached the thread's composer without leaving the pull request. */
export function PullRequestComposerNotice(props: { readonly bottomInset?: number }) {
  const notice = useComposerInsertNotice();
  const selectDetail = useSelectWorkspaceDetail();
  const insets = useSafeAreaInsets();
  if (notice === null) return null;
  return (
    <View
      collapsable={false}
      className="absolute left-4 right-4 z-[100]"
      style={{ bottom: Math.max(insets.bottom, 12) + (props.bottomInset ?? 8) }}
      pointerEvents="box-none"
    >
      <Toast
        message="Added to composer"
        tone="success"
        action={{
          label: "Open",
          onPress: () => {
            dismissComposerInsertNotice();
            selectDetail({
              name: "Thread",
              params: { environmentId: notice.environmentId, threadId: notice.threadId },
            });
          },
        }}
        dismissMode="swipe"
        onDismiss={dismissComposerInsertNotice}
      />
    </View>
  );
}
