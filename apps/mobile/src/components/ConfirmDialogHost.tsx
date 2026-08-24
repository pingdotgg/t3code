import { useCallback, useEffect, useState } from "react";
import { Modal, Pressable, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

import { useThemeColor } from "../lib/useThemeColor";
import { cn } from "../lib/cn";
import { AppText, AppTextInput as TextInput } from "./AppText";

export type ConfirmDialogRequest = {
  readonly title: string;
  readonly message?: string;
  readonly cancelText?: string;
  readonly confirmText: string;
  readonly destructive?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel?: () => void;
};

export type PromptDialogRequest = {
  readonly title: string;
  readonly message?: string;
  readonly placeholder?: string;
  /** Prefills the field and is selected on open, so typing replaces it. */
  readonly initialValue?: string;
  readonly cancelText?: string;
  readonly confirmText: string;
  /** Receives the raw field text; the caller owns trimming and no-op rules. */
  readonly onConfirm: (value: string) => void;
  readonly onCancel?: () => void;
};

type DialogRequest =
  | { readonly kind: "confirm"; readonly request: ConfirmDialogRequest }
  | { readonly kind: "prompt"; readonly request: PromptDialogRequest };

let presentDialog: ((dialog: DialogRequest) => void) | null = null;

/**
 * Imperative confirm dialog, Alert.alert-shaped. Native iOS alerts already
 * match the app (and support per-button destructive red), so this is for
 * Android, where the native dialog can only theme all confirm buttons at
 * once. Requires ConfirmDialogHost to be mounted at the app root.
 */
export function showConfirmDialog(request: ConfirmDialogRequest): void {
  presentDialog?.({ kind: "confirm", request });
}

/**
 * Imperative single-field text prompt. Unlike showConfirmDialog this is the
 * only option on both platforms: Alert.prompt is iOS-only. Confirm stays
 * disabled while the field is blank. Requires ConfirmDialogHost at the root.
 */
export function showPromptDialog(request: PromptDialogRequest): void {
  presentDialog?.({ kind: "prompt", request });
}

/**
 * Android-style alert dialog matching the native one themed by
 * withAndroidModernAlertDialog — left-aligned text, right-aligned text
 * buttons — with what the native theme can't do: a per-dialog destructive
 * button color and a dimmer message than the title.
 */
export function ConfirmDialogHost() {
  const [dialog, setDialog] = useState<DialogRequest | null>(null);
  const [draft, setDraft] = useState("");
  const pressedOverlay = useThemeColor("--color-subtle");

  useEffect(() => {
    presentDialog = (next) => {
      setDialog(next);
      setDraft(next.kind === "prompt" ? (next.request.initialValue ?? "") : "");
    };
    return () => {
      presentDialog = null;
    };
  }, []);

  const handleCancel = useCallback(() => {
    dialog?.request.onCancel?.();
    setDialog(null);
  }, [dialog]);

  const confirmDisabled = dialog?.kind === "prompt" && draft.trim().length === 0;

  const handleConfirm = useCallback(() => {
    if (dialog === null) return;
    if (dialog.kind === "prompt") {
      if (draft.trim().length === 0) return;
      dialog.request.onConfirm(draft);
    } else {
      dialog.request.onConfirm();
    }
    setDialog(null);
  }, [dialog, draft]);

  return (
    <Modal
      visible={dialog !== null}
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={handleCancel}
    >
      {dialog === null ? null : (
        <KeyboardAvoidingView automaticOffset behavior="padding" style={{ flex: 1 }}>
          <View className="flex-1 items-center justify-center bg-backdrop px-8">
            <View className="w-full rounded-[24px] bg-card px-6 pb-4 pt-5">
              <AppText className="text-lg font-t3-medium">{dialog.request.title}</AppText>
              {dialog.request.message === undefined ? null : (
                <AppText className="mt-2 text-sm text-foreground-secondary">
                  {dialog.request.message}
                </AppText>
              )}
              {dialog.kind === "prompt" ? (
                <TextInput
                  autoFocus
                  className="mt-4"
                  onChangeText={setDraft}
                  onSubmitEditing={handleConfirm}
                  placeholder={dialog.request.placeholder}
                  returnKeyType="done"
                  selectTextOnFocus
                  value={draft}
                />
              ) : null}
              <View className="mt-5 flex-row justify-end gap-1">
                <View className="overflow-hidden rounded-full">
                  <Pressable
                    accessibilityRole="button"
                    className="min-h-10 items-center justify-center px-4"
                    android_ripple={{ color: pressedOverlay }}
                    onPress={handleCancel}
                  >
                    <AppText className="text-base font-t3-medium">
                      {dialog.request.cancelText ?? "Cancel"}
                    </AppText>
                  </Pressable>
                </View>
                <View className="overflow-hidden rounded-full">
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled: confirmDisabled }}
                    className="min-h-10 items-center justify-center px-4"
                    android_ripple={{ color: pressedOverlay }}
                    disabled={confirmDisabled}
                    onPress={handleConfirm}
                  >
                    <AppText
                      className={cn(
                        "text-base font-t3-medium",
                        dialog.kind === "confirm" &&
                          dialog.request.destructive &&
                          "text-danger-foreground",
                        confirmDisabled && "text-foreground-muted",
                      )}
                    >
                      {dialog.request.confirmText}
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
