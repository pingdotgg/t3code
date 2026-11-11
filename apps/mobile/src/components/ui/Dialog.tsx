import { Alert } from "react-native";
import type { ConfirmDialogRequest, TextInputDialogRequest } from "./Dialog.types";

export type { ConfirmDialogRequest, TextInputDialogRequest } from "./Dialog.types";

function beginTrackedDialog(onCancel: (() => void) | undefined) {
  let finished = false;
  const finish = (action?: () => void) => {
    if (finished) return;
    finished = true;
    action?.();
  };
  const cancel = () => finish(onCancel);
  const complete = (action: () => void) => finish(action);
  return { cancel, complete };
}

export function alert(...args: Parameters<typeof Alert.alert>): void {
  Alert.alert(...args);
}

export function confirm(request: ConfirmDialogRequest): void {
  const { cancel, complete } = beginTrackedDialog(request.onCancel);
  Alert.alert(request.title, request.message, [
    { text: request.cancelText ?? "Cancel", style: "cancel", onPress: cancel },
    {
      text: request.confirmText,
      style: request.destructive ? "destructive" : "default",
      onPress: () => complete(request.onConfirm),
    },
  ]);
}

export function prompt(request: TextInputDialogRequest): void {
  const { cancel, complete } = beginTrackedDialog(request.onCancel);
  Alert.prompt(
    request.title,
    request.message,
    [
      { text: request.cancelText ?? "Cancel", style: "cancel", onPress: cancel },
      {
        text: request.confirmText,
        onPress: (value) => complete(() => request.onConfirm(value ?? "")),
      },
    ],
    "plain-text",
    request.initialValue,
  );
}

export function Host() {
  return null;
}
