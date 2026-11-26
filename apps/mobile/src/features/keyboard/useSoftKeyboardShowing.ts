import { useSyncExternalStore } from "react";
import { KeyboardController, KeyboardEvents } from "react-native-keyboard-controller";

// `useKeyboardState` only flips on willShow and didHide. This follows the will-events, so a
// layout that makes room for the keyboard gives it back as soon as the keyboard starts hiding.
// Android reports a keyboard it did not animate, such as one a Modal or the share sheet closed,
// with a did-event alone, so those count too.
let keyboardShowing = KeyboardController.isVisible();
function subscribeKeyboardShowing(onChange: () => void) {
  keyboardShowing = KeyboardController.isVisible();
  const follow = (showing: boolean) => () => {
    keyboardShowing = showing;
    onChange();
  };
  const subscriptions = [
    KeyboardEvents.addListener("keyboardWillShow", follow(true)),
    KeyboardEvents.addListener("keyboardDidShow", follow(true)),
    KeyboardEvents.addListener("keyboardWillHide", follow(false)),
    KeyboardEvents.addListener("keyboardDidHide", follow(false)),
  ];
  return () => {
    for (const subscription of subscriptions) subscription.remove();
  };
}
const getKeyboardShowing = () => keyboardShowing;

export function useSoftKeyboardShowing() {
  return useSyncExternalStore(subscribeKeyboardShowing, getKeyboardShowing);
}
