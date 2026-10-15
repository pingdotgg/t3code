import { Alert } from "react-native";
import type { ConfirmDialogRequest, TextInputDialogRequest } from "./Dialog.types";

export type { ConfirmDialogRequest, TextInputDialogRequest } from "./Dialog.types";

export function confirm(request: ConfirmDialogRequest): void {
  Alert.alert(request.title, request.message, [
    { text: request.cancelText ?? "Cancel", style: "cancel", onPress: request.onCancel },
    {
      text: request.confirmText,
      style: request.destructive ? "destructive" : "default",
      onPress: request.onConfirm,
    },
  ]);
}

export function prompt(request: TextInputDialogRequest): void {
  Alert.prompt(
    request.title,
    undefined,
    [
      { text: request.cancelText ?? "Cancel", style: "cancel", onPress: request.onCancel },
      { text: request.confirmText, onPress: (value) => request.onConfirm(value ?? "") },
    ],
    "plain-text",
    request.initialValue,
  );
}

/** iOS alerts are presented directly by React Native. */
export function Host() {
  return null;
}
