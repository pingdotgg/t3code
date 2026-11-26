import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

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

function render() {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<KeyboardShowing />));
  return {
    showing: () => container.textContent,
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

// The hook's state lives at module scope; every test ends with the keyboard hidden.
afterEach(() => emit("keyboardWillHide"));

it("hides on willHide, before the keyboard finishes leaving", () => {
  using screen = render();
  emit("keyboardWillShow");
  emit("keyboardDidShow");
  const shown = screen.showing();
  emit("keyboardWillHide");
  expect([shown, screen.showing()]).toEqual(["true", "false"]);
});

// Android's syncKeyboardPosition reports a keyboard it did not animate, such as one a Modal or
// the share sheet closed, with a did-event alone.
it("follows a keyboard Android reports with a did-event alone", () => {
  using screen = render();
  emit("keyboardWillShow");
  emit("keyboardDidShow");
  emit("keyboardDidHide");
  const hidden = screen.showing();
  emit("keyboardDidShow");
  const shown = screen.showing();
  expect([hidden, shown]).toEqual(["false", "true"]);
});
