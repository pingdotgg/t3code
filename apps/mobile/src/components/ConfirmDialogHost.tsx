import { useCallback, useEffect, useState } from "react";
import { Platform, Modal, Pressable, TextInput, View } from "react-native";

import { cn } from "../lib/cn";
import { AppText } from "./AppText";
import { MaterialConfirmDialog } from "./MaterialConfirmDialog";

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
  readonly initialValue: string;
  readonly cancelText?: string;
  readonly confirmText: string;
  readonly onConfirm: (value: string) => void;
  readonly onCancel?: () => void;
};

type DialogRequest =
  | { readonly kind: "confirm"; readonly request: ConfirmDialogRequest }
  | { readonly kind: "text-input"; readonly request: TextInputDialogRequest };

let presentRequest: ((request: DialogRequest) => void) | null = null;

/**
 * Imperative confirm dialog, Alert.alert-shaped. Native iOS alerts already
 * match the app (and support per-button destructive red), so this is for
 * Android, where the native dialog can only theme all confirm buttons at
 * once. Requires ConfirmDialogHost to be mounted at the app root.
 */
export function showConfirmDialog(request: ConfirmDialogRequest): void {
  presentRequest?.({ kind: "confirm", request });
}

export function showTextInputDialog(request: TextInputDialogRequest): void {
  presentRequest?.({ kind: "text-input", request });
}

/**
 * Android-style alert dialog matching the native one themed by
 * withAndroidModernAlertDialog — left-aligned text, right-aligned text
 * buttons — with what the native theme can't do: a per-dialog destructive
 * button color and a dimmer message than the title.
 */
export function ConfirmDialogHost() {
  const [presented, setPresented] = useState<DialogRequest | null>(null);
  const [inputValue, setInputValue] = useState("");
  useEffect(() => {
    presentRequest = (request) => {
      setInputValue(request.kind === "text-input" ? request.request.initialValue : "");
      setPresented(request);
    };
    return () => {
      presentRequest = null;
    };
  }, []);

  const handleCancel = useCallback(() => {
    presented?.request.onCancel?.();
    setPresented(null);
  }, [presented]);

  const handleConfirm = useCallback(
    (nativeInputValue?: string) => {
      if (presented?.kind === "confirm") {
        presented.request.onConfirm();
      } else if (presented?.kind === "text-input") {
        presented.request.onConfirm(nativeInputValue ?? inputValue);
      }
      setPresented(null);
    },
    [inputValue, presented],
  );

  const confirmDisabled = presented?.kind === "text-input" && inputValue.trim().length === 0;

  if (Platform.OS === "android")
    return presented ? (
      <MaterialConfirmDialog
        key={`${presented.kind}:${presented.request.title}:${presented.kind === "text-input" ? presented.request.initialValue : ""}`}
        request={presented.request}
        inputInitialValue={
          presented.kind === "text-input" ? presented.request.initialValue : undefined
        }
        onInputChange={setInputValue}
        confirmDisabled={confirmDisabled}
        onCancel={handleCancel}
        onConfirm={handleConfirm}
      />
    ) : null;

  return (
    <Modal
      visible={presented !== null}
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={handleCancel}
    >
      {presented === null ? null : (
        <View className="flex-1 items-center justify-center bg-backdrop px-8">
          <View className="w-full rounded-[24px] bg-card px-6 pb-4 pt-5">
            <AppText className="text-lg font-t3-medium">{presented.request.title}</AppText>
            {presented.kind === "confirm" && presented.request.message !== undefined ? (
              <AppText className="mt-2 text-sm text-foreground-secondary">
                {presented.request.message}
              </AppText>
            ) : null}
            {presented.kind === "text-input" ? (
              <TextInput
                accessibilityLabel={presented.request.title}
                autoFocus
                className="mt-4 rounded-xl border border-border bg-screen px-3 py-2.5 text-base text-foreground"
                onChangeText={setInputValue}
                onSubmitEditing={confirmDisabled ? undefined : () => handleConfirm()}
                returnKeyType="done"
                selectTextOnFocus
                value={inputValue}
              />
            ) : null}
            <View className="mt-5 flex-row justify-end gap-1">
              <View className="overflow-hidden rounded-full">
                <Pressable
                  accessibilityRole="button"
                  className="min-h-10 items-center justify-center px-4 active:bg-subtle"
                  onPress={handleCancel}
                >
                  <AppText className="text-base font-t3-medium">
                    {presented.request.cancelText ?? "Cancel"}
                  </AppText>
                </Pressable>
              </View>
              <View className="overflow-hidden rounded-full">
                <Pressable
                  accessibilityRole="button"
                  disabled={confirmDisabled}
                  className="min-h-10 items-center justify-center px-4 active:bg-subtle"
                  onPress={() => handleConfirm()}
                >
                  <AppText
                    className={cn(
                      "text-base font-t3-medium",
                      presented.kind === "confirm" &&
                        presented.request.destructive &&
                        "text-danger-foreground",
                      confirmDisabled && "text-foreground-tertiary",
                    )}
                  >
                    {presented.request.confirmText}
                  </AppText>
                </Pressable>
              </View>
            </View>
          </View>
        </View>
      )}
    </Modal>
  );
}
