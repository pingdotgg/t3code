import { describe, expect, it, vi } from "vite-plus/test";

import { fakeTimers } from "../../test/render";
import { observeSelectionActions, SELECTION_MULTI_CLICK_INTERVAL_MS } from "./selectionActions";

describe("observeSelectionActions", () => {
  it.each([
    { immediateMultiClick: false, before: [], after: [[{ x: 40, y: 12 }]] },
    { immediateMultiClick: true, before: [[null]], after: [[null]] },
  ])(
    "double-click with immediateMultiClick=$immediateMultiClick",
    ({ immediateMultiClick, before, after }) => {
      using stack = new DisposableStack();
      const element = stack.adopt(document.body.appendChild(document.createElement("div")), (e) =>
        e.remove(),
      );
      stack.use(fakeTimers());
      const onSelection = vi.fn();
      const actions = observeSelectionActions({
        element,
        immediateMultiClick,
        onSelection,
        onDismiss: () => {},
      });
      stack.defer(() => actions.dispose());

      element.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, isPrimary: true, button: 0 }),
      );
      element.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          button: 0,
          detail: 2,
          clientX: 40,
          clientY: 12,
        }),
      );

      vi.advanceTimersByTime(SELECTION_MULTI_CLICK_INTERVAL_MS - 1);
      expect(onSelection.mock.calls).toEqual(before);
      vi.advanceTimersByTime(50);
      expect(onSelection.mock.calls).toEqual(after);
    },
  );
});
