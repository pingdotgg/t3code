import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadStateAtom } from "~/state/threads";

const INTENT_DELAY_MS = 150;
// A tap leaves the row before its click opens the thread, so the hold outlives the pointer.
const RELEASE_DELAY_MS = 1_000;

/**
 * Loads a thread's detail once the pointer rests on its row, or at pointerdown, so the click
 * renders the timeline in its first frame instead of an empty one. The opened thread holds its own
 * subscription, so the row lets go soon after the pointer leaves.
 */
export function useThreadIntentPrefetch(threadRef: ScopedThreadRef) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const release = useRef<(() => void) | null>(null);
  const stop = () => {
    clearTimeout(timer.current);
    release.current?.();
    release.current = null;
  };
  const start = () => {
    clearTimeout(timer.current);
    if (release.current !== null) return;
    release.current = appAtomRegistry.mount(
      environmentThreadStateAtom(threadRef.environmentId, threadRef.threadId),
    );
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases a held thread subscription when the row unmounts
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      release.current?.();
      release.current = null;
    },
    [],
  );
  return {
    onPointerEnter: (event: React.PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      clearTimeout(timer.current);
      timer.current = setTimeout(start, release.current === null ? INTENT_DELAY_MS : 0);
    },
    onPointerLeave: () => {
      clearTimeout(timer.current);
      if (release.current !== null) timer.current = setTimeout(stop, RELEASE_DELAY_MS);
    },
    onPointerDown: start,
  };
}
