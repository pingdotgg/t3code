const SCROLL_GATE_DRAG_THRESHOLD = 4;
const SCROLL_GATE_SETTLE_MS = 160;

export function createSwipeableScrollGate(onChange: (active: boolean) => void) {
  let active = false;
  let dragging = false;
  let dragStartY = 0;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  const setActive = (next: boolean) => {
    if (active === next) return;
    active = next;
    onChange(next);
  };

  const clearSettle = () => {
    if (settleTimer !== null) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
  };

  const scheduleSettle = () => {
    clearSettle();
    // Unlock only; a paused drag that resumes must still re-gate.
    settleTimer = setTimeout(() => {
      settleTimer = null;
      setActive(false);
    }, SCROLL_GATE_SETTLE_MS);
  };

  return {
    onScrollBeginDrag(offsetY: number) {
      dragging = true;
      dragStartY = offsetY;
      // Keep the settle fallback armed if a new drag starts while already gated (e.g. catching momentum).
      if (active) scheduleSettle();
      else clearSettle();
    },
    onScroll(offsetY: number) {
      if (dragging && !active && Math.abs(offsetY - dragStartY) > SCROLL_GATE_DRAG_THRESHOLD) {
        setActive(true);
      }
      // Android ReactScrollView skips onScrollEndDrag on ACTION_CANCEL and skips
      // onMomentumScrollEnd when touch-down cancels post-touch scrolling; always keep
      // a settle fallback armed while gated so stillness unlocks swipes.
      if (active) scheduleSettle();
    },
    onScrollEndDrag() {
      dragging = false;
      if (active) scheduleSettle();
    },
    onMomentumScrollBegin() {
      if (active) scheduleSettle();
    },
    onMomentumScrollEnd() {
      dragging = false;
      clearSettle();
      setActive(false);
    },
    reset() {
      dragging = false;
      clearSettle();
      setActive(false);
    },
    dispose() {
      clearSettle();
    },
  };
}
