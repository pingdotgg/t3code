import { useSyncExternalStore } from "react";
import { KeyboardController, KeyboardEvents } from "react-native-keyboard-controller";

// Follows the will-events so a layout gives the keyboard's room back as soon as it starts hiding.
// Android can skip them: a cancelled show ends with didHide alone, and a nonanimated IME change
// resyncs with a lone did-event. The did-events settle the state, or a missed willHide would
// leave the keyboard reported shown, hiding the navigation bar until the app restarts.
let keyboardShowing = KeyboardController.isVisible();
function subscribeKeyboardShowing(onChange: () => void) {
  keyboardShowing = KeyboardController.isVisible();
  const update = (showing: boolean) => () => {
    keyboardShowing = showing;
    onChange();
  };
  const subscriptions = [
    KeyboardEvents.addListener("keyboardWillShow", update(true)),
    KeyboardEvents.addListener("keyboardDidShow", update(true)),
    KeyboardEvents.addListener("keyboardWillHide", update(false)),
    KeyboardEvents.addListener("keyboardDidHide", update(false)),
  ];
  return () => {
    for (const subscription of subscriptions) subscription.remove();
  };
}
const getKeyboardShowing = () => keyboardShowing;

export function useSoftKeyboardShowing() {
  return useSyncExternalStore(subscribeKeyboardShowing, getKeyboardShowing);
}
