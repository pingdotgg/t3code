import { expect, it, vi } from "vite-plus/test";

const listeners = vi.hoisted(() => new Map<string, Set<() => void>>());

vi.mock("react-native-keyboard-controller", () => ({
  KeyboardController: { isVisible: () => false },
  KeyboardEvents: {
    addListener: (name: string, listener: () => void) => {
      const named = listeners.get(name) ?? new Set();
      named.add(listener);
      listeners.set(name, named);
      return { remove: () => named.delete(listener) };
    },
  },
}));

import { getKeyboardShowEpoch, subscribeKeyboardShowing } from "./terminalKeyboardShowing";

function emit(name: string) {
  for (const listener of listeners.get(name) ?? []) listener();
}

// Android's syncKeyboardPosition repairs a nonanimated IME inset change with
// keyboardDidHide then keyboardDidShow, and no will-events.
it("keeps the accessory through Android's did-only repair and starts a new show after it", () => {
  // Two mounted terminal screens, each reading the snapshot when notified.
  const seen = [0, 0];
  const unsubscribes = seen.map((_, index) => {
    seen[index] = getKeyboardShowEpoch();
    return subscribeKeyboardShowing(() => {
      seen[index] = getKeyboardShowEpoch();
    });
  });
  const trace = [
    "keyboardWillShow",
    "keyboardDidShow",
    "keyboardDidHide",
    "keyboardDidShow",
    "keyboardWillHide",
    "keyboardWillShow",
  ].map((name) => {
    emit(name);
    return {
      epoch: getKeyboardShowEpoch(),
      inSync: seen.every((s) => s === getKeyboardShowEpoch()),
    };
  });

  const [shown, settled, repairHidden, repairShown, hidden, reshown] = trace.map((t) => t.epoch);
  expect({
    neverHiddenByRepair: [shown, settled, repairHidden, repairShown].every((epoch) => epoch !== 0),
    sameShow: settled === shown && repairHidden === shown,
    newShow: repairShown !== shown,
    hidden,
    newShowAfterHide: reshown !== 0 && reshown !== repairShown,
    subscribersInSync: trace.every((t) => t.inSync),
  }).toEqual({
    neverHiddenByRepair: true,
    sameShow: true,
    newShow: true,
    hidden: 0,
    newShowAfterHide: true,
    subscribersInSync: true,
  });
  for (const unsubscribe of unsubscribes) unsubscribe();
});
