import { KeyboardController, KeyboardEvents } from "react-native-keyboard-controller";

// The accessory leaves on willHide, before `useKeyboardState` sees didHide. Android
// repairs a nonanimated IME change with didHide then didShow alone: that didHide must
// not hide the accessory (it would clear the terminal's focus), but the didShow after
// it starts a new show so a dismissed accessory comes back.
const subscribers = new Set<() => void>();
let showEpoch = 1;
let keyboardShowing = KeyboardController.isVisible();
let hiddenSinceShow = !keyboardShowing;
let keyboardMoving = false;
const settleRuns = new Map<object, () => void>();

const notify = () => {
  for (const subscriber of subscribers) subscriber();
};
const settle = () => {
  keyboardMoving = false;
  const runs = [...settleRuns.values()];
  settleRuns.clear();
  for (const run of runs) run();
};
const show = () => {
  if (hiddenSinceShow) showEpoch += 1;
  hiddenSinceShow = false;
  keyboardShowing = true;
  notify();
};
KeyboardEvents.addListener("keyboardWillShow", () => {
  keyboardMoving = true;
  show();
});
KeyboardEvents.addListener("keyboardDidShow", () => {
  show();
  settle();
});
KeyboardEvents.addListener("keyboardWillHide", () => {
  keyboardMoving = true;
  keyboardShowing = false;
  hiddenSinceShow = true;
  notify();
});
KeyboardEvents.addListener("keyboardDidHide", () => {
  hiddenSinceShow = true;
  settle();
});

// Runs now, or once the keyboard stops moving; a later call for the same owner replaces it.
export function runWhenKeyboardSettles(owner: object, run: () => void) {
  if (!keyboardMoving) {
    settleRuns.delete(owner);
    run();
    return;
  }
  settleRuns.set(owner, run);
}

export function subscribeKeyboardShowing(onChange: () => void) {
  subscribers.add(onChange);
  return () => {
    subscribers.delete(onChange);
  };
}

// 0 while hidden; otherwise a number that changes with every new show.
export const getKeyboardShowEpoch = () => (keyboardShowing ? showEpoch : 0);
