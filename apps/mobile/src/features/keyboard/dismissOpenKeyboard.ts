import { KeyboardController, KeyboardEvents } from "react-native-keyboard-controller";

let dismissPending = false;
KeyboardEvents.addListener("keyboardDidShow", () => {
  dismissPending = false;
});
KeyboardEvents.addListener("keyboardDidHide", () => {
  dismissPending = false;
});

// Dismisses the soft keyboard when one is really open; returns whether it did.
export function dismissOpenKeyboard(): boolean {
  // RN's Keyboard and TextInputState miss the chat composer, a custom native EditText. The
  // keyboard controller tracks the IME natively and resyncs on resume, so it sees the composer.
  if (!KeyboardController.isVisible()) return false;
  // Dismissing an already-hidden IME emits no keyboardDidHide, so a missed hide would leave
  // isVisible() stuck true. A second Back before any hide lands lets the caller act instead.
  if (dismissPending) return false;
  dismissPending = true;
  void KeyboardController.dismiss();
  return true;
}
