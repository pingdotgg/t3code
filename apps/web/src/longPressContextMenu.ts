import type { PointerEvent as ReactPointerEvent } from "react";

const LONG_PRESS_DELAY_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE_PX = 5;

let pendingPress: { origin: { x: number; y: number }; timeoutId: number } | null = null;

function cancelPendingPress() {
  if (!pendingPress) return;
  window.clearTimeout(pendingPress.timeoutId);
  document.removeEventListener("contextmenu", cancelPendingPress, true);
  pendingPress = null;
}

function suppressRestOfGesture() {
  const suppress = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const stopSuppressing = () => {
    document.removeEventListener("click", suppress, true);
    document.removeEventListener("contextmenu", suppress, true);
  };
  document.addEventListener("click", suppress, true);
  document.addEventListener("contextmenu", suppress, true);
  document.addEventListener("pointerdown", stopSuppressing, { capture: true, once: true });
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("input, textarea, [contenteditable]") !== null;
}

export const longPressContextMenuProps = {
  "data-long-press-context-menu": "",
  onPointerCancel: cancelPendingPress,
  onPointerDown: (event: ReactPointerEvent) => {
    cancelPendingPress();
    if (event.pointerType !== "touch" || isTextEntryTarget(event.target)) return;

    const target = event.currentTarget;
    const origin = { x: event.clientX, y: event.clientY };
    pendingPress = {
      origin,
      timeoutId: window.setTimeout(() => {
        cancelPendingPress();
        target.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: origin.x,
            clientY: origin.y,
          }),
        );
        suppressRestOfGesture();
      }, LONG_PRESS_DELAY_MS),
    };
    document.addEventListener("contextmenu", cancelPendingPress, true);
  },
  onPointerMove: (event: ReactPointerEvent) => {
    if (!pendingPress) return;
    const movedX = Math.abs(event.clientX - pendingPress.origin.x);
    const movedY = Math.abs(event.clientY - pendingPress.origin.y);
    if (movedX > LONG_PRESS_MOVE_TOLERANCE_PX || movedY > LONG_PRESS_MOVE_TOLERANCE_PX) {
      cancelPendingPress();
    }
  },
  onPointerUp: cancelPendingPress,
};
