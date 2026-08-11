import { useCallback, useEffect, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, TextInput, View } from "react-native";

import { useThemeColor } from "../lib/useThemeColor";
import { cn } from "../lib/cn";
import { AppText } from "./AppText";

export type ConfirmDialogRequest = {
  readonly title: string;
  readonly message?: string;
  readonly cancelText?: string;
  readonly confirmText: string;
  readonly destructive?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel?: () => void;
};

export type TextInputDialogRequest = {
  readonly title: string;
  readonly defaultValue: string;
  readonly cancelText?: string;
  readonly confirmText: string;
  readonly onSubmit: (value: string) => void;
  readonly onCancel?: () => void;
};

type DialogRequest =
  | ({ readonly kind: "confirm" } & ConfirmDialogRequest)
  | ({ readonly kind: "text-input" } & TextInputDialogRequest);

let presentRequest: ((request: DialogRequest) => void) | null = null;

/**
 * Imperative confirm dialog, Alert.alert-shaped. Native iOS alerts already
 * match the app (and support per-button destructive red), so this is for
 * Android, where the native dialog can only theme all confirm buttons at
 * once. Requires ConfirmDialogHost to be mounted at the app root.
 */
export function showConfirmDialog(request: ConfirmDialogRequest): void {
  presentRequest?.({ kind: "confirm", ...request });
}

export function showTextInputDialog(request: TextInputDialogRequest): void {
  presentRequest?.({ kind: "text-input", ...request });
}

/**
 * Android-style alert dialog matching the native one themed by
 * withAndroidModernAlertDialog — left-aligned text, right-aligned text
 * buttons — with what the native theme can't do: a per-dialog destructive
 * button color and a dimmer message than the title.
 */
export function ConfirmDialogHost() {
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const [inputValue, setInputValue] = useState("");
  const pressedOverlay = useThemeColor("--color-subtle");
  const inputBackground = useThemeColor("--color-subtle");
  const inputBorder = useThemeColor("--color-border");
  const inputText = useThemeColor("--color-foreground");
  const inputSelection = useThemeColor("--color-user-bubble");

  useEffect(() => {
    presentRequest = setRequest;
    return () => {
      presentRequest = null;
    };
  }, []);

  useEffect(() => {
    if (request?.kind === "text-input") {
      setInputValue(request.defaultValue);
    }
  }, [request]);

  const handleCancel = useCallback(() => {
    request?.onCancel?.();
    setRequest(null);
  }, [request]);

  const handleConfirm = useCallback(() => {
    if (request?.kind === "confirm") {
      request.onConfirm();
    } else if (request?.kind === "text-input") {
      request.onSubmit(inputValue);
    }
    setRequest(null);
  }, [inputValue, request]);

  const inputIsEmpty = request?.kind === "text-input" && inputValue.trim().length === 0;

  return (
    <Modal
      visible={request !== null}
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={handleCancel}
    >
      {request === null ? null : (
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          className="flex-1 items-center justify-center bg-backdrop px-8"
        >
          <View className="w-full rounded-[24px] bg-card px-6 pb-4 pt-5">
            <AppText className="text-lg font-t3-medium">{request.title}</AppText>
            {request.kind !== "confirm" || request.message === undefined ? null : (
              <AppText className="mt-2 text-sm text-foreground-secondary">
                {request.message}
              </AppText>
            )}
            {request.kind === "text-input" ? (
              <TextInput
                accessibilityLabel={request.title}
                autoFocus
                className="mt-4 min-h-12 rounded-xl border px-3 py-2 text-base"
                onChangeText={setInputValue}
                onSubmitEditing={inputIsEmpty ? undefined : handleConfirm}
                returnKeyType="done"
                selectTextOnFocus
                selectionColor={inputSelection}
                style={{
                  backgroundColor: inputBackground,
                  borderColor: inputBorder,
                  color: inputText,
                }}
                value={inputValue}
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
                    {request.cancelText ?? "Cancel"}
                  </AppText>
                </Pressable>
              </View>
              <View className="overflow-hidden rounded-full">
                <Pressable
                  accessibilityRole="button"
                  className="min-h-10 items-center justify-center px-4"
                  disabled={inputIsEmpty}
                  android_ripple={{ color: pressedOverlay }}
                  onPress={handleConfirm}
                >
                  <AppText
                    className={cn(
                      "text-base font-t3-medium",
                      request.kind === "confirm" && request.destructive && "text-danger-foreground",
                      inputIsEmpty && "text-foreground-muted",
                    )}
                  >
                    {request.confirmText}
                  </AppText>
                </Pressable>
              </View>
            </View>
          </View>
        </KeyboardAvoidingView>
      )}
    </Modal>
  );
}
