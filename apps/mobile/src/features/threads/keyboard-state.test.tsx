import { act } from "react";
import { createRoot } from "react-dom/client";
import type { KeyboardEventData } from "react-native-keyboard-controller/src/types";
import { expect, it, vi } from "vite-plus/test";

const listeners = vi.hoisted(() => new Map<string, Set<(event: KeyboardEventData) => void>>());
vi.mock("react-native-keyboard-controller/src/bindings", () => ({
  KeyboardControllerNative: {},
  KeyboardEvents: {
    addListener: (name: string, listener: (event: KeyboardEventData) => void) => {
      const callbacks = listeners.get(name) ?? new Set<(event: KeyboardEventData) => void>();
      callbacks.add(listener);
      listeners.set(name, callbacks);
      return { remove: () => callbacks.delete(listener) };
    },
  },
}));
import { KeyboardController } from "react-native-keyboard-controller/src/module";
import { useKeyboardState } from "react-native-keyboard-controller/src/hooks/useKeyboardState";

function Height() {
  return <output>{useKeyboardState((state) => state.height)}</output>;
}

it("recovers keyboard height when Android restores the IME without will-show", () => {
  const emit = (name: string, height: number) => {
    for (const listener of listeners.get(name) ?? []) {
      listener({
        height,
        duration: 0,
        timestamp: 0,
        target: 1,
        type: "default",
        appearance: "light",
      });
    }
  };
  emit("keyboardDidHide", 0);
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  act(() => root.render(<Height />));
  expect(container.textContent).toBe("0");
  act(() => emit("keyboardDidShow", 320));
  expect(KeyboardController.state().height).toBe(320);
  expect(KeyboardController.isVisible()).toBe(true);
  expect(container.textContent).toBe("320");
  act(() => emit("keyboardDidHide", 0));
  expect(container.textContent).toBe("0");
});
