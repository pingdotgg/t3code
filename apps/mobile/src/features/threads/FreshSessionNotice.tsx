import { View } from "react-native";

import { Notice } from "../../components/ui/Notice";
import { setFreshSessionPending, useComposerDraftSettings } from "../../state/use-composer-drafts";

/** Shown while `/clear` or `/recap` is armed; dismissing it keeps the current session. */
export function FreshSessionNotice(props: { readonly threadKey: string }) {
  const settings = useComposerDraftSettings(props.threadKey);
  if (settings.freshContext !== true) return null;
  const withRecap = settings.contextHandoffOnFresh === true;
  return (
    <View className="px-4 pb-3">
      <Notice
        message={
          withRecap
            ? "Your next message starts a fresh session with a written recap. Distinct from Compact and Clear."
            : "Your next message starts a fresh session. The agent won't see earlier messages in this thread."
        }
        icon={withRecap ? "doc.text" : "arrow.clockwise"}
        floating
        onDismiss={() => setFreshSessionPending(props.threadKey, false)}
        dismissLabel="Keep the current session"
      />
    </View>
  );
}
