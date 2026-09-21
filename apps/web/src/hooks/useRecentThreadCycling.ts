import { useCallback, useEffect, useRef } from "react";

import {
  cycleRecentThread,
  EMPTY_THREAD_RECENCY_STATE,
  endThreadRecencyWalk,
  isModifierKeyName,
  recordThreadVisit,
} from "../threadRecency";

// Session-scoped on purpose: the thread sidebar unmounts on settings routes,
// and Settings then back must not forget which threads were visited.
let recencyState = EMPTY_THREAD_RECENCY_STATE;
let walkEndListenersAttached = false;

function attachWalkEndListeners(): void {
  if (walkEndListenersAttached || typeof window === "undefined") return;
  walkEndListenersAttached = true;
  const endWalk = () => {
    recencyState = endThreadRecencyWalk(recencyState);
  };
  window.addEventListener(
    "keyup",
    (event) => {
      if (isModifierKeyName(event.key)) endWalk();
    },
    true,
  );
  window.addEventListener("blur", endWalk);
}

/**
 * Backs `thread.cycleRecent`. Records the routed thread as visited and ends an
 * in-progress walk when a modifier key is released or the window blurs, so a
 * held Ctrl+Tab, Ctrl+Tab steps two threads back while Ctrl+Tab, release,
 * Ctrl+Tab flips between the two newest.
 */
export function useRecentThreadCycling(routeThreadKey: string | null) {
  const routeThreadKeyRef = useRef(routeThreadKey);

  useEffect(() => {
    routeThreadKeyRef.current = routeThreadKey;
    recencyState = recordThreadVisit(recencyState, routeThreadKey);
  }, [routeThreadKey]);

  useEffect(attachWalkEndListeners, []);

  return useCallback((isKnownThread: (threadKey: string) => boolean): string | null => {
    const result = cycleRecentThread(recencyState, {
      currentThreadKey: routeThreadKeyRef.current,
      isKnownThread,
    });
    recencyState = result.state;
    return result.target;
  }, []);
}
