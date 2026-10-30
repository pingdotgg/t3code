import { useSyncExternalStore } from "react";
import { KeyboardController, KeyboardEvents } from "react-native-keyboard-controller";

// `useKeyboardState` only flips on willShow and didHide. This follows the will-events, so a
// layout that makes room for the keyboard gives it back as soon as the keyboard starts hiding.
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

export function useSoftKeyboardShowing() {
  return useSyncExternalStore(subscribeKeyboardShowing, getKeyboardShowing);
}
