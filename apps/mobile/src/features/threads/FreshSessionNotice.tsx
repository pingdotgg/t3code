import { useGT } from "gt-react-native";
import { View } from "react-native";

import { Notice } from "../../components/ui/Notice";
import { setFreshSessionPending, useComposerDraftSettings } from "../../state/use-composer-drafts";

/** Shown while `/clear` is armed; dismissing it keeps the current session. */
export function FreshSessionNotice(props: { readonly threadKey: string }) {
  const gt = useGT();
  if (useComposerDraftSettings(props.threadKey).freshContext !== true) return null;
  return (
    <View className="px-4 pb-3">
      <Notice
        message={gt(
          "Your next message starts a fresh session. The agent won't see earlier messages in this thread.",
        )}
        icon="arrow.clockwise"
        floating
        onDismiss={() => setFreshSessionPending(props.threadKey, false)}
        dismissLabel={gt("Keep the current session")}
      />
    </View>
  );
}
