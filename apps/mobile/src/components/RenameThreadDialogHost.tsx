import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, Pressable, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

import { useThemeColor } from "../lib/useThemeColor";
import { cn } from "../lib/cn";
import { AppText, AppTextInput } from "./AppText";

export type RenameThreadDialogRequest = {
  /** Dialog heading. Defaults to "Rename thread". */
  readonly title?: string;
  /** Prefills the field; the user edits from here. */
  readonly initialValue: string;
  readonly confirmText?: string;
  readonly cancelText?: string;
  /** Called with the trimmed value only when it is non-empty and changed. */
  readonly onSubmit: (value: string) => void;
  readonly onCancel?: () => void;
};

let presentRequest: ((request: RenameThreadDialogRequest) => void) | null = null;

/**
 * Imperative rename dialog. React Native's Alert.prompt is iOS-only, so
 * renaming a thread needs a custom modal to work on Android — this is the
 * text-input sibling of showConfirmDialog. Requires RenameThreadDialogHost to
 * be mounted at the app root.
 */
export function showRenameThreadDialog(request: RenameThreadDialogRequest): void {
  presentRequest?.(request);
}

/**
 * Single-field rename dialog styled to match ConfirmDialogHost: a centered
 * card with a title, a prefilled text field, and Cancel / Rename actions.
 * Rename stays disabled until the trimmed value is non-empty.
 */
export function RenameThreadDialogHost() {
  const [request, setRequest] = useState<RenameThreadDialogRequest | null>(null);
  const [value, setValue] = useState("");
  const inputRef = useRef<TextInput>(null);
  const pressedOverlay = useThemeColor("--color-subtle");

  useEffect(() => {
    presentRequest = (next) => {
      setRequest(next);
      setValue(next.initialValue);
    };
    return () => {
      presentRequest = null;
    };
  }, []);

  const handleCancel = useCallback(() => {
    request?.onCancel?.();
    setRequest(null);
  }, [request]);

  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0;

  const handleConfirm = useCallback(() => {
    if (request === null) return;
    const next = value.trim();
    if (next.length === 0) return;
    // A no-op rename still dismisses the dialog, but never dispatches a
    // pointless metadata update for an unchanged title.
    if (next !== request.initialValue.trim()) {
      request.onSubmit(next);
    }
    setRequest(null);
  }, [request, value]);

  return (
    <Modal
      visible={request !== null}
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={handleCancel}
      onShow={() => inputRef.current?.focus()}
    >
      {request === null ? null : (
        <KeyboardAvoidingView automaticOffset behavior="padding" className="flex-1">
          <View className="flex-1 items-center justify-center bg-backdrop px-8">
            <View className="w-full rounded-[24px] bg-card px-6 pb-4 pt-5">
              <AppText className="text-lg font-t3-medium">
                {request.title ?? "Rename thread"}
              </AppText>
              <AppTextInput
                ref={inputRef}
                className="mt-4"
                value={value}
                onChangeText={setValue}
                autoFocus
                selectTextOnFocus
                returnKeyType="done"
                onSubmitEditing={handleConfirm}
                placeholder="Thread name"
                accessibilityLabel="Thread name"
              />
              <View className="mt-5 flex-row justify-end gap-1">
                <View className="overflow-hidden rounded-full">
                  <Pressable
                    accessibilityRole="button"
                    className="min-h-10 items-center justify-center px-4"
                    android_ripple={{ color: pressedOverlay }}
                    onPress={handleCancel}
                  >
                    <AppText className="text-base font-t3-medium">
                      {request.cancelText ?? "Cancel"}
                    </AppText>
                  </Pressable>
                </View>
                <View className="overflow-hidden rounded-full">
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled: !canSubmit }}
                    className="min-h-10 items-center justify-center px-4"
                    android_ripple={{ color: pressedOverlay }}
                    disabled={!canSubmit}
                    onPress={handleConfirm}
                  >
                    <AppText
                      className={cn(
                        "text-base font-t3-medium",
                        canSubmit || "text-foreground-tertiary",
                      )}
                    >
                      {request.confirmText ?? "Rename"}
                    </AppText>
                  </Pressable>
                </View>
              </View>
            </View>
          </View>
        </KeyboardAvoidingView>
      )}
    </Modal>
  );
}
