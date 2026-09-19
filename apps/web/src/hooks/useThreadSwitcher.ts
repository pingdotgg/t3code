import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  advanceThreadSwitcherIndex,
  isThreadSwitcherHoldModifierKey,
  recordThreadSwitcherVisit,
  resolveThreadSwitcherOrder,
  type ThreadSwitcherHoldModifier,
} from "../threadSwitcher";

interface ThreadSwitcherSession {
  readonly holdModifier: ThreadSwitcherHoldModifier;
  /** The thread the switch began on; any other navigation cancels the switch. */
  readonly originThreadKey: string | null;
  /** The router pathname when the switch began, for checks that cannot wait for a render. */
  readonly originPathname: string;
  readonly threadKeys: readonly string[];
  readonly index: number;
}

export interface ThreadSwitcher {
  /** Thread keys on offer while switching, or null when the overlay is closed. */
  readonly threadKeys: readonly string[] | null;
  readonly index: number;
  /**
   * Opens the switcher on the first press and moves the highlight afterwards.
   * Navigation waits for the modifier's release, so cycling past a thread never
   * loads it.
   */
  readonly advance: (
    holdModifier: ThreadSwitcherHoldModifier,
    direction: "next" | "previous",
  ) => void;
}

/**
 * Drives the thread switcher overlay for one sidebar. The visit history lives
 * here rather than in persisted UI state: switch order is about this session's
 * working set, and an order restored from last week would put the wrong thread
 * one tap away.
 */
export function useThreadSwitcher({
  navigateToThreadKey,
  orderedThreadKeys,
  routeThreadKey,
}: {
  orderedThreadKeys: readonly string[];
  routeThreadKey: string | null;
  navigateToThreadKey: (threadKey: string) => void;
}): ThreadSwitcher {
  const router = useRouter();
  const [session, setSession] = useState<ThreadSwitcherSession | null>(null);
  const historyRef = useRef<readonly string[]>([]);

  // Another shortcut, a click or a remote event moved the route mid-switch:
  // close the overlay on the next render. The release handler also checks the
  // router directly, because the URL changes before React renders the new route.
  if (session !== null && session.originThreadKey !== routeThreadKey) {
    setSession(null);
  }

  useEffect(() => {
    if (routeThreadKey === null) return;
    historyRef.current = recordThreadSwitcherVisit(historyRef.current, routeThreadKey);
  }, [routeThreadKey]);

  const advance = useCallback(
    (holdModifier: ThreadSwitcherHoldModifier, direction: "next" | "previous") => {
      setSession((current) => {
        if (current !== null && current.holdModifier === holdModifier) {
          return {
            ...current,
            index: advanceThreadSwitcherIndex({
              count: current.threadKeys.length,
              direction,
              index: current.index,
            }),
          };
        }
        const threadKeys = resolveThreadSwitcherOrder({
          activeThreadKey: routeThreadKey,
          history: historyRef.current,
          threadKeys: orderedThreadKeys,
        });
        if (threadKeys.length < 2) return null;
        return {
          holdModifier,
          originThreadKey: routeThreadKey,
          originPathname: router.history.location.pathname,
          index: advanceThreadSwitcherIndex({ count: threadKeys.length, direction, index: 0 }),
          threadKeys,
        };
      });
    },
    [orderedThreadKeys, routeThreadKey, router],
  );

  useEffect(() => {
    if (session === null) return;

    const onKeyUp = (event: KeyboardEvent) => {
      if (!isThreadSwitcherHoldModifierKey(event.key, session.holdModifier)) return;
      setSession(null);
      // The router's history rather than window.location: desktop routes live
      // in the hash.
      if (router.history.location.pathname !== session.originPathname) return;
      const threadKey = session.threadKeys[session.index];
      if (threadKey !== undefined) navigateToThreadKey(threadKey);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setSession(null);
    };
    // Switching windows mid-cycle drops the modifier without a keyup. Cancelling
    // rather than committing keeps a window change from moving the thread.
    const onBlur = () => setSession(null);

    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [navigateToThreadKey, router, session]);

  return { advance, index: session?.index ?? 0, threadKeys: session?.threadKeys ?? null };
}
