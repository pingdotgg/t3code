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

export function DialogHost() {
  const [presented, setPresented] = useState<
    (TextInputDialogRequest & { readonly id: number }) | null
  >(null);
  const nextPresentationId = useRef(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Register the native prompt presenter for this host's lifetime.
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
  const pendingAction = useRef<(() => void) | null>(null);
  const [visible, setVisible] = useState(true);
  const [value, setValue] = useState(request.initialValue);
  const settle = (run: () => void) => {
    if (pendingAction.current) return;
    pendingAction.current = run;
    setVisible(false);
  };
  const dismissed = () => {
    const run = pendingAction.current;
    if (!run) return;
    pendingAction.current = null;
    props.onClose();
    // Callbacks can present another native alert or sheet only after UIKit dismisses this modal.
    run();
  };
  const cancel = () => settle(() => request.onCancel?.());
  const submit = () => settle(() => request.onConfirm(value));

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      supportedOrientations={["portrait", "portrait-upside-down", "landscape"]}
      onShow={() => inputRef.current?.focus()}
      onRequestClose={cancel}
      onDismiss={dismissed}
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
