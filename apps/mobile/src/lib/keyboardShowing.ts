import { useSyncExternalStore } from "react";
import { KeyboardController, KeyboardEvents } from "react-native-keyboard-controller";

// `useKeyboardState` only flips on willShow and didHide; this follows the
// will-events so UI can leave as soon as the keyboard starts hiding.
let keyboardShowing = KeyboardController.isVisible();
function subscribeKeyboardShowing(onChange: () => void) {
  keyboardShowing = KeyboardController.isVisible();
  const willShow = KeyboardEvents.addListener("keyboardWillShow", () => {
    keyboardShowing = true;
    onChange();
  });
  const willHide = KeyboardEvents.addListener("keyboardWillHide", () => {
    keyboardShowing = false;
    onChange();
  });
  return () => {
    willShow.remove();
    willHide.remove();
  };
}
const getKeyboardShowing = () => keyboardShowing;

export function useKeyboardShowing(): boolean {
  return useSyncExternalStore(subscribeKeyboardShowing, getKeyboardShowing);
}
