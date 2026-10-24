import { useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  ScrollView,
  useWindowDimensions,
  View,
  type TextInputInstance,
} from "react-native";

import { useAppearancePreferences } from "../../features/settings/appearance/AppearancePreferencesProvider";
import { AppText, AppTextInput } from "./AppText";
import { Button } from "./Button";
import { registerPromptPresenter, type TextInputDialogRequest } from "./Dialog";
import { GlassSurface } from "./GlassSurface";

/** iOS presenter for Dialog.prompt; alerts and confirms are presented directly by React Native. */
export function DialogHost() {
  const [presented, setPresented] = useState<
    (TextInputDialogRequest & { readonly id: number }) | null
  >(null);
  const nextPresentationId = useRef(0);
  useEffect(() => {
    const present = (request: TextInputDialogRequest) =>
      setPresented({ ...request, id: ++nextPresentationId.current });
    return registerPromptPresenter(present);
  }, []);

  return presented ? (
    <PromptDialog key={presented.id} request={presented} onClose={() => setPresented(null)} />
  ) : null;
}

/**
 * A React Native Modal presents from its nearest view controller, and the root one cannot present
 * over a native sheet. Mount this inside sheets that open prompts.
 */
export const DialogSheetHost = DialogHost;

function PromptDialog(props: {
  readonly request: TextInputDialogRequest;
  readonly onClose: () => void;
}) {
  const { request } = props;
  const { width, height, fontScale } = useWindowDimensions();
  const stackActions = fontScale > 1.3;
  const { themeVariables } = useAppearancePreferences();
  const inputRef = useRef<TextInputInstance>(null);
  const settled = useRef(false);
  const [value, setValue] = useState(request.initialValue);
  // A second tap can land before the modal unmounts; only the first one counts.
  const settle = (run: () => void) => {
    if (settled.current) return;
    settled.current = true;
    props.onClose();
    run();
  };
  const cancel = () => settle(() => request.onCancel?.());
  const submit = () => settle(() => request.onConfirm(value));

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onShow={() => inputRef.current?.focus()}
      onRequestClose={cancel}
    >
      <KeyboardAvoidingView
        behavior="padding"
        className="flex-1 items-center justify-center bg-backdrop p-6"
      >
        <GlassSurface
          accessibilityViewIsModal
          className="bg-sheet"
          tintColorClassName="accent-sheet/20"
          fallbackColor={themeVariables["--color-sheet"]}
          style={{ width: Math.min(340, width - 48), maxHeight: height - 96, borderRadius: 28 }}
        >
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerClassName="gap-4 p-5"
            alwaysBounceVertical={false}
          >
            <AppText accessibilityRole="header" textRole="title" className="text-center">
              {request.title}
            </AppText>
            {request.message ? (
              <AppText textRole="footnote" className="text-center text-foreground-muted">
                {request.message}
              </AppText>
            ) : null}
            <AppTextInput
              ref={inputRef}
              accessibilityLabel={request.title}
              placeholder={request.placeholder}
              value={value}
              onChangeText={setValue}
              selectTextOnFocus
              clearButtonMode="while-editing"
              returnKeyType="done"
              submitBehavior="submit"
              onSubmitEditing={submit}
            />
            <View className={stackActions ? "flex-col-reverse gap-3" : "flex-row gap-3"}>
              <View className={stackActions ? undefined : "flex-1"}>
                <Button fullWidth label={request.cancelText ?? "Cancel"} onPress={cancel} />
              </View>
              <View className={stackActions ? undefined : "flex-1"}>
                <Button fullWidth tone="primary" label={request.confirmText} onPress={submit} />
              </View>
            </View>
          </ScrollView>
        </GlassSurface>
      </KeyboardAvoidingView>
    </Modal>
  );
}
