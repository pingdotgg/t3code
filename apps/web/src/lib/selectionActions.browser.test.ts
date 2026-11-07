import { expect, it, vi } from "vite-plus/test";

import { observeSelectionActions } from "./selectionActions";

it.each([
  { name: "claims Escape while the action is showing", showing: true },
  { name: "leaves Escape unclaimed with no action showing", showing: false },
])("$name", ({ showing }) => {
  const onDismiss = vi.fn();
  const actions = observeSelectionActions({
    element: document.createElement("div"),
    getActionElement: () => (showing ? document.createElement("button") : null),
    onSelection: () => {},
    onDismiss,
  });
  using _actions = { [Symbol.dispose]: actions.dispose };

  const reachedWindow = vi.fn();
  window.addEventListener("keydown", reachedWindow);
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  document.body.dispatchEvent(escape);
  window.removeEventListener("keydown", reachedWindow);

  expect(escape.defaultPrevented).toBe(showing);
  expect(reachedWindow).toHaveBeenCalledTimes(showing ? 0 : 1);
  expect(onDismiss).toHaveBeenCalledExactlyOnceWith("cancel");
});
