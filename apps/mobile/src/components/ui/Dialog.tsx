import { Alert } from "react-native";
import type { ConfirmDialogRequest, TextInputDialogRequest } from "./Dialog.types";

export type { ConfirmDialogRequest, TextInputDialogRequest } from "./Dialog.types";

export function alert(...args: Parameters<typeof Alert.alert>): void {
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

// The most recently mounted host presents, so a sheet's host wins while the sheet is open.
const promptPresenters: Array<(request: TextInputDialogRequest) => void> = [];

// UIAlertController's text field lays out past the alert's edge on iOS 26 (Liquid Glass),
// so prompts render in-app through DialogHost instead of through Alert.prompt.
export function prompt(request: TextInputDialogRequest): void {
  promptPresenters.at(-1)?.(request);
}

export function registerPromptPresenter(present: (request: TextInputDialogRequest) => void) {
  promptPresenters.push(present);
  return () => {
    promptPresenters.splice(promptPresenters.indexOf(present), 1);
  };
}
