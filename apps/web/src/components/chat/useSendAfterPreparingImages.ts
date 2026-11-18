import { useEffect, useRef } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import {
  usePreparingComposerImageFailures,
  usePreparingComposerImages,
} from "./preparingComposerImages";

/**
 * Holds a send made while pasted images are still compressing, and makes it once the last one
 * has joined the draft. A tool that pastes screenshots and presses Enter at once sends them too.
 * When an image fails to compress, the held send is dropped and the draft stays as it is.
 */
export function useSendAfterPreparingImages(targetKey: string) {
  const preparingCount = usePreparingComposerImages(targetKey).length;
  const failures = usePreparingComposerImageFailures(targetKey);
  const pendingRef = useRef<{
    readonly targetKey: string;
    readonly failures: number;
    readonly send: () => void;
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- makes the held send once compression ends; the draft insert happens in the same tick
  useEffect(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    // A send held for another draft does not follow the user to this one.
    if (pending.targetKey !== targetKey) {
      pendingRef.current = null;
      return;
    }
    // A sent message without the image the user pasted is worse than no send.
    if (pending.failures !== failures) {
      pendingRef.current = null;
      return;
    }
    if (preparingCount > 0) return;
    pendingRef.current = null;
    pending.send();
  }, [failures, preparingCount, targetKey]);
  return useStableCallback((send: () => void) => {
    pendingRef.current = { targetKey, failures, send };
  });
}
