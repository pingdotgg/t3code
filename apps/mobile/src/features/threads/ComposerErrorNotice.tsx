import { View } from "react-native";
import { Notice } from "../../components/Notice";

/** Why the thread's last message did not send, above the composer until dismissed. */
export function ComposerErrorNotice(props: {
  readonly message: string;
  readonly onDismiss: () => void;
}) {
  return (
    <View className="px-4 pb-3">
      <Notice
        message={props.message}
        icon="exclamationmark.circle"
        iconTone="danger"
        floating
        onDismiss={props.onDismiss}
        dismissLabel="Dismiss error"
      />
    </View>
  );
}
