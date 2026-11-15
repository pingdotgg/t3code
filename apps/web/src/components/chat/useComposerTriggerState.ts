import { useRef, useState } from "react";

import type { ComposerTrigger } from "../../composer-logic";

const isSameTrigger = (a: ComposerTrigger | null, b: ComposerTrigger | null) =>
  a !== null && b !== null && a.kind === b.kind && a.rangeStart === b.rangeStart;

/** Edits open suggestions unless Escape dismissed the trigger; caret moves only close, resets can open. */
export function useComposerTriggerState(initialTrigger: () => ComposerTrigger | null) {
  const [trigger, setActiveTrigger] = useState(initialTrigger);
  // Key handlers read this before React commits the state.
  const activeTriggerRef = useRef(trigger);
  const dismissedTriggerRef = useRef<ComposerTrigger | null>(null);

  const activate = (next: ComposerTrigger | null) => {
    activeTriggerRef.current = next;
    setActiveTrigger(next);
  };

  /** The trigger at the caret when its menu is the open one, otherwise null. */
  const resolveTrigger = (candidate: ComposerTrigger | null) =>
    isSameTrigger(activeTriggerRef.current, candidate) ? candidate : null;

  /** After a text edit, with the trigger at the caret. */
  const setTrigger = (candidate: ComposerTrigger | null) => {
    if (isSameTrigger(dismissedTriggerRef.current, candidate)) {
      activate(null);
      return;
    }
    dismissedTriggerRef.current = null;
    activate(candidate);
  };

  /** After the caret moved without an edit, with the trigger at the caret. */
  const followCaret = (candidate: ComposerTrigger | null) => {
    if (!isSameTrigger(dismissedTriggerRef.current, candidate)) {
      dismissedTriggerRef.current = null;
    }
    activate(resolveTrigger(candidate));
  };

  const dismissTrigger = (candidate: ComposerTrigger | null) => {
    dismissedTriggerRef.current = candidate;
    activate(null);
  };

  const resetTrigger = (candidate: ComposerTrigger | null) => {
    dismissedTriggerRef.current = null;
    activate(candidate);
  };

  return { trigger, setTrigger, followCaret, resolveTrigger, dismissTrigger, resetTrigger };
}
