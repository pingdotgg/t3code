import { KeyboardController, KeyboardEvents } from "react-native-keyboard-controller";

// The accessory leaves on willHide, before `useKeyboardState` sees didHide. Android
// repairs a nonanimated IME change with didHide then didShow alone: that didHide must
// not hide the accessory (it would clear the terminal's focus), but the didShow after
// it starts a new show so a dismissed accessory comes back.
const subscribers = new Set<() => void>();
let showEpoch = 1;
let keyboardShowing = KeyboardController.isVisible();
let hiddenSinceShow = !keyboardShowing;

const notify = () => {
  for (const subscriber of subscribers) subscriber();
};
const show = () => {
  if (hiddenSinceShow) showEpoch += 1;
  hiddenSinceShow = false;
  keyboardShowing = true;
  notify();
};
KeyboardEvents.addListener("keyboardWillShow", show);
KeyboardEvents.addListener("keyboardDidShow", show);
KeyboardEvents.addListener("keyboardWillHide", () => {
  keyboardShowing = false;
  hiddenSinceShow = true;
  notify();
});
KeyboardEvents.addListener("keyboardDidHide", () => {
  hiddenSinceShow = true;
});

export function subscribeKeyboardShowing(onChange: () => void) {
  subscribers.add(onChange);
  return () => {
    subscribers.delete(onChange);
  };
}

// 0 while hidden; otherwise a number that changes with every new show.
export const getKeyboardShowEpoch = () => (keyboardShowing ? showEpoch : 0);
