import type { AlertButton, AlertOptions } from "react-native";

/** Back or outside taps invoke an alert's cancel/only action unless cancelability is explicit. */
export function resolveAlertDismissal(request: {
  readonly buttons: readonly AlertButton[];
  readonly options?: AlertOptions | undefined;
}):
  | { readonly kind: "ignore" }
  | { readonly kind: "dismiss" }
  | { readonly kind: "press"; readonly button: AlertButton } {
  if (request.options?.cancelable === true) return { kind: "dismiss" };
  if (request.options?.cancelable === false) return { kind: "ignore" };
  const button =
    request.buttons.find((candidate) => candidate.style === "cancel") ??
    (request.buttons.length === 1 ? request.buttons[0] : undefined);
  return button ? { kind: "press", button } : { kind: "ignore" };
}
