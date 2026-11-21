import { msg } from "gt-react-native";
import { Alert } from "react-native";

import { m } from "../../i18n/messages";
import type { ConfirmDialogRequest, TextInputDialogRequest } from "./Dialog.types";
import { defineNativePluginFeature } from "../../plugins/features";

export const Host = defineNativePluginFeature("native.components.ui.dialog.host", BuiltinHost);

export type { ConfirmDialogRequest, TextInputDialogRequest } from "./Dialog.types";

export function alert(...args: Parameters<typeof Alert.alert>): void {
  Alert.alert(...args);
}

export function confirm(request: ConfirmDialogRequest): void {
  Alert.alert(request.title, request.message, [
    { text: request.cancelText ?? m(msg("Cancel")), style: "cancel", onPress: request.onCancel },
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
      { text: request.cancelText ?? m(msg("Cancel")), style: "cancel", onPress: request.onCancel },
      { text: request.confirmText, onPress: (value) => request.onConfirm(value ?? "") },
    ],
    "plain-text",
    request.initialValue,
  );
}

function BuiltinHost() {
  return null;
}
