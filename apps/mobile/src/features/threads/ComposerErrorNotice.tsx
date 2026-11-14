import { View } from "react-native";
import { Button } from "../../components/ui/Button";
import { Notice } from "../../components/ui/Notice";

export function ComposerErrorNotice(props: {
  readonly message: string;
  readonly onDismiss: () => void;
  readonly onStop?: (() => void) | undefined;
}) {
  return (
    <View className="gap-2 px-4 pb-3">
      <Notice
        message={props.message}
        icon="exclamationmark.circle"
        iconTone="danger"
        floating
        onDismiss={props.onDismiss}
        dismissLabel="Dismiss error"
      />
      {props.onStop ? (
        <View className="flex-row justify-end">
          <Button label="Stop" icon="stop.fill" size="compact" onPress={props.onStop} />
        </View>
      ) : null}
    </View>
  );
}
