import { KeyboardController, KeyboardEvents } from "react-native-keyboard-controller";

let dismissPending = false;
for (const event of ["keyboardWillShow", "keyboardDidShow", "keyboardDidHide"] as const) {
  KeyboardEvents.addListener(event, () => {
    dismissPending = false;
  });
}

export function dismissOpenKeyboard(): boolean {
  // The custom composer is a native EditText outside React Native's focus tracking.
  if (!KeyboardController.isVisible()) return false;
  // A missed hide event must not leave Back trapped behind a stale visible cache.
  if (dismissPending) return false;
  dismissPending = true;
  void KeyboardController.dismiss();
  return true;
}
