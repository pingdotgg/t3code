import { useCallback, useRef, useState } from "react";

import { continueComposerPathTrigger } from "@t3tools/shared/composerTrigger";
import { detectComposerTrigger, type ComposerTrigger } from "../../composer-logic";

/** Keep a dismissed suggestion closed until the caret leaves its token. */
export function useComposerTriggerState(initialText: string) {
  const [trigger, setActiveTrigger] = useState(() =>
    detectComposerTrigger(initialText, initialText.length),
  );
  const previousSearchRef = useRef({ text: initialText, trigger });
  const dismissedTriggerRef = useRef<ComposerTrigger | null>(null);

  const detectTrigger = useCallback((text: string, cursor: number) => {
    const previous = previousSearchRef.current;
    const candidate =
      detectComposerTrigger(text, cursor) ??
      continueComposerPathTrigger(text, cursor, previous.trigger, previous.text);
    previousSearchRef.current = { text, trigger: candidate };
    return candidate;
  }, []);

  const resolveTrigger = useCallback((candidate: ComposerTrigger | null) => {
    const dismissed = dismissedTriggerRef.current;
    return candidate &&
      dismissed &&
      candidate.kind === dismissed.kind &&
      candidate.rangeStart === dismissed.rangeStart
      ? null
      : candidate;
  }, []);

  const setTrigger = useCallback(
    (candidate: ComposerTrigger | null) => {
      if (previousSearchRef.current.trigger !== candidate) {
        previousSearchRef.current = { text: "", trigger: null };
      }
      const activeTrigger = resolveTrigger(candidate);
      if (candidate === null || activeTrigger !== null) {
        dismissedTriggerRef.current = null;
      }
      setActiveTrigger(activeTrigger);
    },
    [resolveTrigger],
  );

  const dismissTrigger = useCallback((candidate: ComposerTrigger | null) => {
    dismissedTriggerRef.current = candidate;
    setActiveTrigger(null);
  }, []);

  const resetTrigger = useCallback((candidate: ComposerTrigger | null, text: string) => {
    previousSearchRef.current = { text, trigger: candidate };
    dismissedTriggerRef.current = null;
    setActiveTrigger(candidate);
  }, []);

  return { trigger, detectTrigger, setTrigger, resolveTrigger, dismissTrigger, resetTrigger };
}
