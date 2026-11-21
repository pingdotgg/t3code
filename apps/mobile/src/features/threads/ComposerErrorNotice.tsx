import { useGT } from "gt-react-native";
import { View } from "react-native";
import { Notice } from "../../components/ui/Notice";
import { defineNativePluginFeature } from "../../plugins/features";

function BuiltinComposerErrorNotice(props: {
  readonly message: string;
  readonly onDismiss: () => void;
}) {
  const gt = useGT();
  return (
    <View className="px-4 pb-3">
      <Notice
        message={props.message}
        icon="exclamationmark.circle"
        iconTone="danger"
        floating
        onDismiss={props.onDismiss}
        dismissLabel={gt("Dismiss error")}
      />
    </View>
  );
}

export const ComposerErrorNotice = defineNativePluginFeature(
  "native.features.threads.composer-error-notice",
  BuiltinComposerErrorNotice,
);
