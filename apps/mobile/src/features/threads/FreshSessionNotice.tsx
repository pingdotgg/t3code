import { View } from "react-native";

import { Notice } from "../../components/ui/Notice";
import { setFreshSessionPending, useFreshSessionPending } from "../../state/use-composer-drafts";

/** Shown while `/clear` is armed; dismissing it keeps the current session. */
export function FreshSessionNotice(props: { readonly threadKey: string }) {
  if (!useFreshSessionPending(props.threadKey)) return null;
  return (
    <View className="px-4 pb-3">
      <Notice
        message="Your next message starts a fresh session. The agent won't see earlier messages in this thread."
        icon="arrow.clockwise"
        floating
        onDismiss={() => setFreshSessionPending(props.threadKey, false)}
        dismissLabel="Keep the current session"
      />
    </View>
  );
}
