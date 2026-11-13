import { continueComposerPathTrigger } from "@t3tools/shared/composerTrigger";
import { useRef, useState } from "react";

import { detectComposerTrigger, type ComposerTrigger } from "../../composer-logic";

export function useComposerTriggerState(initialTrigger: () => ComposerTrigger | null) {
  const [trigger, setActiveTrigger] = useState(initialTrigger);
  // Handlers can run twice before a render, so the trigger an edit continues is read from here.
  const activeTriggerRef = useRef(trigger);
  const dismissedTriggerRef = useRef<ComposerTrigger | null>(null);

  const activate = (next: ComposerTrigger | null) => {
    activeTriggerRef.current = next;
    setActiveTrigger(next);
  };

  /** The trigger at the caret, where a space continues the `@` search that was already active. */
  const detectTrigger = (text: string, cursor: number) => {
    return continueComposerPathTrigger({
      text,
      cursor,
      detected: detectComposerTrigger(text, cursor),
      previous: activeTriggerRef.current,
    });
  };

  /** Ends `candidate` unless a newer edit already replaced it. */
  const endTrigger = (candidate: ComposerTrigger | null) => {
    if (candidate !== null && activeTriggerRef.current === candidate) activate(null);
  };

  const resolveTrigger = (candidate: ComposerTrigger | null) => {
    const dismissed = dismissedTriggerRef.current;
    return candidate &&
      dismissed &&
      candidate.kind === dismissed.kind &&
      candidate.rangeStart === dismissed.rangeStart
      ? null
      : candidate;
  };

  const setTrigger = (candidate: ComposerTrigger | null) => {
    const activeTrigger = resolveTrigger(candidate);
    if (candidate === null || activeTrigger !== null) {
      dismissedTriggerRef.current = null;
    }
    activate(activeTrigger);
  };

  const dismissTrigger = (candidate: ComposerTrigger | null) => {
    dismissedTriggerRef.current = candidate;
    activate(null);
  };

  const resetTrigger = (candidate: ComposerTrigger | null) => {
    dismissedTriggerRef.current = null;
    activate(candidate);
  };

  return {
    trigger,
    detectTrigger,
    endTrigger,
    setTrigger,
    resolveTrigger,
    dismissTrigger,
    resetTrigger,
  };
}
