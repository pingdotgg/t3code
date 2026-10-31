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

export function alert(
  ...args: [
    title: string,
    message?: string,
    buttons?: Parameters<typeof Alert.alert>[2],
    options?: DialogAlertOptions,
  ]
): void {
  Alert.alert(...args);
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

export function Host() {
  return null;
}
