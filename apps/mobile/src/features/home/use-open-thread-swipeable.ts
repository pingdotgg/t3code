import { useState } from "react";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

/**
 * Tracks the one open thread swipe row. `consumeOpenSwipeable` closes it and
 * returns true so the tap dismisses first instead of also opening a thread.
 */
export function createOpenThreadSwipeable() {
  let open: SwipeableMethods | null = null;

  return {
    handleSwipeableWillOpen(methods: SwipeableMethods) {
      if (open !== methods) {
        open?.close();
        open = methods;
      }
    },
    handleSwipeableClose(methods: SwipeableMethods) {
      if (open === methods) open = null;
    },
    closeOpenSwipeable() {
      open?.close();
    },
    consumeOpenSwipeable(): boolean {
      if (!open) return false;
      const current = open;
      open = null;
      current.close();
      return true;
    },
  };
}

export function useOpenThreadSwipeable() {
  const [api] = useState(createOpenThreadSwipeable);
  return api;
}
