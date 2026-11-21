import { act } from "react";
import { createRoot } from "react-dom/client";
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

import { useSoftKeyboardShowing } from "./useSoftKeyboardShowing";

function emit(name: string) {
  act(() => {
    for (const listener of listeners.get(name) ?? []) listener();
  });
}

function KeyboardShowing() {
  return <output>{String(useSoftKeyboardShowing())}</output>;
}

// Two mounted consumers, like the Android navigation bar and its sidebar copy.
function renderConsumers() {
  const roots = [0, 1].map(() => {
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => root.render(<KeyboardShowing />));
    return { container, root };
  });
  return {
    read: () => roots.map(({ container }) => container.textContent),
    [Symbol.dispose]: () => {
      for (const { root } of roots) act(() => root.unmount());
    },
  };
}

function replay(events: readonly string[]) {
  using consumers = renderConsumers();
  for (const event of events) emit(event);
  return consumers.read();
}

it("hides as soon as the keyboard starts hiding", () => {
  expect(replay(["keyboardWillShow", "keyboardDidShow", "keyboardWillHide"])).toEqual([
    "false",
    "false",
  ]);
});

// The navigation bar unmounts while the keyboard shows, so a stuck flag hides it until restart.
it("reports hidden after Android cancels a show and ends it with didHide alone", () => {
  expect(replay(["keyboardWillShow", "keyboardDidHide"])).toEqual(["false", "false"]);
});

it("follows Android's nonanimated IME resync, which sends did-events alone", () => {
  expect(replay(["keyboardDidShow"])).toEqual(["true", "true"]);
  expect(replay(["keyboardDidShow", "keyboardDidHide"])).toEqual(["false", "false"]);
});
