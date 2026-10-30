import { describe, expect, it, vi } from "vite-plus/test";

import { fakeTimers } from "../../test/render";
import {
  advanceTerminalSelectionClickSequence,
  type TerminalSelectionClickSequence,
} from "../terminal/ghostty/surface";
import { observeSelectionActions, SELECTION_MULTI_CLICK_INTERVAL_MS } from "./selectionActions";

function click(element: HTMLElement, detail: number) {
  element.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, isPrimary: true, button: 0, detail }),
  );
  window.dispatchEvent(new MouseEvent("mouseup", { button: 0, detail, clientX: 10, clientY: 20 }));
}

describe("observeSelectionActions", () => {
  it("shows actions on the next frame after a triple-click, not after the multi-click wait", () => {
    using stack = new DisposableStack();
    const element = stack.adopt(document.body.appendChild(document.createElement("p")), (node) =>
      node.remove(),
    );
    stack.use(fakeTimers());
    const onSelection = vi.fn();
    const actions = observeSelectionActions({ element, onSelection, onDismiss: () => {} });
    stack.defer(() => actions.dispose());

    click(element, 1);
    click(element, 2);
    vi.advanceTimersToNextFrame();
    expect(onSelection, "a double-click waits for a possible third click").not.toHaveBeenCalled();

    click(element, 3);
    vi.advanceTimersToNextFrame();
    expect(onSelection, "a triple-click shows actions on the next frame").toHaveBeenCalledWith({
      x: 10,
      y: 20,
    });

    onSelection.mockClear();
    click(element, 1);
    click(element, 2);
    vi.advanceTimersByTime(SELECTION_MULTI_CLICK_INTERVAL_MS);
    vi.advanceTimersToNextFrame();
    expect(onSelection).toHaveBeenCalledOnce();
  });

  it("waits after a caller's cycling word click even when the browser detail is 3", () => {
    using stack = new DisposableStack();
    const element = stack.adopt(document.body.appendChild(document.createElement("p")), (node) =>
      node.remove(),
    );
    stack.use(fakeTimers());
    let sequence: TerminalSelectionClickSequence | null = null;
    const onSelection = vi.fn();
    const actions = observeSelectionActions({
      element,
      getClickCount: () => sequence?.count ?? 0,
      onSelection,
      onDismiss: () => {},
    });
    stack.defer(() => actions.dispose());

    for (let clicks = 1; clicks <= 5; clicks++) {
      sequence = advanceTerminalSelectionClickSequence(sequence, {
        clientX: 10,
        clientY: 20,
        timeStamp: clicks * 100,
      });
      click(element, Math.min(clicks, 3));
    }
    expect(sequence?.count).toBe(2);
    vi.advanceTimersToNextFrame();
    expect(onSelection, "a sixth click can still grow the word").not.toHaveBeenCalled();

    vi.advanceTimersByTime(SELECTION_MULTI_CLICK_INTERVAL_MS);
    vi.advanceTimersToNextFrame();
    expect(onSelection).toHaveBeenCalledOnce();
  });
});
