import { useEffect, useState } from "react";
import { Modal, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";

export function useMessageRewindConfirmation(threadKey: string) {
  const [pending, setPending] = useState<{
    readonly threadKey: string;
    readonly resolve: (restoreFiles: boolean | null) => void;
  } | null>(null);

  useEffect(() => {
    if (pending !== null && pending.threadKey !== threadKey) setPending(null);
    // A route change must release the rewind lock just like dismissing the dialog.
    return () => pending?.resolve(null);
  }, [pending, threadKey]);

  const finish = (restoreFiles: boolean | null) => {
    pending?.resolve(restoreFiles);
    setPending(null);
  };

  return {
    confirm: () =>
      new Promise<boolean | null>((resolve) => {
        setPending({ threadKey, resolve });
      }),
    dialog:
      pending?.threadKey === threadKey ? (
        <MessageRewindDialog onChoose={finish} onClose={() => finish(null)} />
      ) : null,
  };
}

function MessageRewindDialog(props: {
  readonly onChoose: (restoreFiles: boolean) => void;
  readonly onClose: () => void;
}) {
  const [restoreFiles, setRestoreFiles] = useState(false);
  return (
    <Modal transparent animationType="fade" onRequestClose={props.onClose}>
      <View className="flex-1 items-center justify-center px-6">
        <Pressable
          className="absolute inset-0 bg-black/40"
          accessible={false}
          onPress={props.onClose}
        />
        <View
          accessibilityViewIsModal
          className="w-full max-w-[360px] gap-4 rounded-3xl bg-card p-6"
        >
          <Text accessibilityRole="header" className="font-t3-medium text-xl">
            Edit from here?
          </Text>
          <Text className="text-sm leading-5 text-foreground-secondary">
            Remove this message and later replies, and return the prompt to the composer.
          </Text>
          <View className="flex-row items-center justify-between gap-4 py-1">
            <View className="min-w-0 flex-1 gap-1">
              <Text className="font-t3-medium text-base">Revert files too</Text>
              <Text className="text-xs leading-4 text-foreground-secondary">
                {restoreFiles
                  ? "Also undo file changes, including your own edits."
                  : "Keep your current file changes."}
              </Text>
            </View>
            <ThemedSwitch
              accessibilityLabel="Revert files too"
              value={restoreFiles}
              onValueChange={setRestoreFiles}
            />
          </View>
          <View className="flex-row items-center justify-end gap-2 pt-1">
            <Button label="Cancel" tone="text" onPress={props.onClose} />
            <Button
              label="Rewind"
              tone={restoreFiles ? "danger" : "primary"}
              onPress={() => props.onChoose(restoreFiles)}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}
