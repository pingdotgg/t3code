import { Alert } from "react-native";
import type {
  ConfirmDialogRequest,
  DialogAlertOptions,
  TextInputDialogRequest,
} from "./Dialog.types";

export type {
  ConfirmDialogRequest,
  DialogAlertOptions,
  TextInputDialogRequest,
} from "./Dialog.types";

/** Informational and multi-action alerts share the same platform presenter. */
export function alert(
  title: string,
  message?: string,
  buttons?: Parameters<typeof Alert.alert>[2],
  options?: DialogAlertOptions,
): void {
  Alert.alert(title, message, buttons, options);
}

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
    request.message,
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
