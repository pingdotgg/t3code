import { useRef, useState } from "react";

import type { ComposerTrigger } from "../../composer-logic";

export interface ComposerTriggerState {
  /** The trigger whose suggestions are showing. */
  readonly open: ComposerTrigger | null;
  /** The trigger Escape closed, which stays closed while the caret is in its word. */
  readonly dismissed: ComposerTrigger | null;
}

/** How the caret came to rest on a trigger: by changing the text, or by moving through it. */
export type ComposerTriggerChange = "edit" | "caret";

function isSameTrigger(a: ComposerTrigger | null, b: ComposerTrigger | null) {
  return a !== null && b !== null && a.kind === b.kind && a.rangeStart === b.rangeStart;
}

/** The caret's trigger when its suggestions are showing, which is when the menu takes keys. */
export function openComposerTrigger(
  state: ComposerTriggerState,
  candidate: ComposerTrigger | null,
) {
  return isSameTrigger(candidate, state.open) ? candidate : null;
}

/**
 * Only an edit opens suggestions. A caret move follows the open trigger or closes it, because
 * open suggestions take the arrow keys, Enter and Tab from text the user is only moving through.
 */
export function nextComposerTriggerState(
  state: ComposerTriggerState,
  candidate: ComposerTrigger | null,
  change: ComposerTriggerChange,
): ComposerTriggerState {
  if (candidate === null) return { open: null, dismissed: null };
  if (isSameTrigger(candidate, state.dismissed)) return { open: null, dismissed: state.dismissed };
  return {
    open: change === "edit" ? candidate : openComposerTrigger(state, candidate),
    dismissed: null,
  };
}

export function useComposerTriggerState(initialTrigger: () => ComposerTrigger | null) {
  const [trigger, setActiveTrigger] = useState(initialTrigger);
  // Key handlers run before the next render, so they read the state from here.
  const stateRef = useRef<ComposerTriggerState>({ open: trigger, dismissed: null });

  const commit = (next: ComposerTriggerState) => {
    stateRef.current = next;
    setActiveTrigger(next.open);
  };

  const resolveTrigger = (candidate: ComposerTrigger | null) =>
    openComposerTrigger(stateRef.current, candidate);

  const setTrigger = (candidate: ComposerTrigger | null, change: ComposerTriggerChange = "edit") =>
    commit(nextComposerTriggerState(stateRef.current, candidate, change));

  const dismissTrigger = (candidate: ComposerTrigger | null) =>
    commit({ open: null, dismissed: candidate });

  const resetTrigger = (candidate: ComposerTrigger | null) =>
    commit({ open: candidate, dismissed: null });

  return { trigger, setTrigger, resolveTrigger, dismissTrigger, resetTrigger };
}
