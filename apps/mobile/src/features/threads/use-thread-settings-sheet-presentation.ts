import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { KeyboardController } from "react-native-keyboard-controller";

import type { ComposerEditorHandle } from "../../components/ComposerEditor";

type PresentationPhase = "closed" | "opening" | "visible";

/**
 * The navigator-level UIKit completion event added by the repo's
 * `@react-navigation/native-stack` patch; absent from upstream event maps.
 */
export type NavigationWithFinishTransitioning = {
  readonly addListener: (type: "finishTransitioning", callback: () => void) => () => void;
};

/**
 * How long after the dismissal's state change the keyboard starts rising, so
 * its ~250ms show overlaps the tail of the sheet's ~500ms travel the way
 * UIKit apps choreograph it. This is aesthetics, not correctness: without
 * keepFocus-style inputView overrides a show started mid-dismissal completes
 * cleanly, so a slower device merely gets more overlap — no failure mode.
 * The navigator's `finishTransitioning` event (UIKit's real completion
 * callback, surfaced by the repo's native-stack patch) additionally bounds
 * the restore at the true landing moment should this timer ever lag it.
 */
const SHEET_DISMISSAL_KEYBOARD_OVERLAP_MS = 300;

/**
 * A JS-initiated dismissal pops state before its animation runs; a
 * gesture-driven one animates natively first and pops afterwards, with the
 * navigator's completion event landing a few dozen milliseconds before the
 * pop. A completion this fresh at pop time therefore means the sheet is
 * already gone and the keyboard should return immediately. The two orderings
 * are separated by the sheet's full ~500ms travel, so this window is a
 * classification with wide margin, not an animation race.
 */
const NATIVE_DISMISSAL_ECHO_WINDOW_MS = 150;

/**
 * Keeps the custom native composer and the settings sheet from owning focus at
 * the same time. Opening resigns the editor cleanly; a dismissal re-focuses it
 * once the sheet has fully landed. A plain blur/focus pair costs one keyboard
 * animation each way — keepFocus-style inputView overrides are avoided because
 * removing them forces UIKit to reload input views, replaying the keyboard's
 * show as a visible collapse/re-open.
 */
export function useThreadSettingsSheetPresentation(input: {
  readonly editorRef: RefObject<ComposerEditorHandle | null>;
  readonly isEditorFocused: boolean;
}) {
  const [phase, setPhase] = useState<PresentationPhase>("closed");
  const isActiveRef = useRef(false);
  const isMountedRef = useRef(true);
  const isEditorFocusedRef = useRef(input.isEditorFocused);
  const openingIdRef = useRef(0);
  const focusRestoreIdRef = useRef(0);
  const restoreFocusAfterDismissRef = useRef(false);
  const restorePendingRef = useRef(false);
  const lastStackTransitionFinishedAtRef = useRef(0);
  const dismissRestoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearDismissRestoreTimer = useCallback(() => {
    if (dismissRestoreTimerRef.current !== null) {
      clearTimeout(dismissRestoreTimerRef.current);
      dismissRestoreTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    isEditorFocusedRef.current = input.isEditorFocused;
  }, [input.isEditorFocused]);

  useEffect(() => {
    // React Strict Mode and Fast Refresh both run an effect cleanup/setup
    // cycle without recreating refs. Re-arm the mounted guard on every setup.
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      isActiveRef.current = false;
      openingIdRef.current += 1;
      focusRestoreIdRef.current += 1;
      clearDismissRestoreTimer();
    };
  }, [clearDismissRestoreTimer]);

  const open = useCallback(() => {
    if (isActiveRef.current) {
      return;
    }

    isActiveRef.current = true;
    focusRestoreIdRef.current += 1;
    clearDismissRestoreTimer();
    restorePendingRef.current = false;
    restoreFocusAfterDismissRef.current = input.isEditorFocused || KeyboardController.isVisible();
    setPhase("opening");

    const openingId = openingIdRef.current + 1;
    openingIdRef.current = openingId;

    // Start the keyboard transition before the custom native editor resigns
    // first responder, then present the sheet on the next frame. The sheet and
    // keyboard animate together instead of serializing two native transitions.
    void KeyboardController.dismiss({ animated: true });
    input.editorRef.current?.blur();

    requestAnimationFrame(() => {
      if (!isMountedRef.current || !isActiveRef.current || openingIdRef.current !== openingId) {
        return;
      }
      setPhase("visible");
    });
  }, [clearDismissRestoreTimer, input.editorRef, input.isEditorFocused]);

  const restoreEditorFocus = useCallback(() => {
    const focusRestoreId = focusRestoreIdRef.current + 1;
    focusRestoreIdRef.current = focusRestoreId;
    let attemptsRemaining = 20;

    // Restoration runs after the dismissal transition, so the first attempt
    // normally succeeds; the retries are insurance against UIKit briefly
    // refusing first-responder status right at the transition boundary.
    const restoreFocus = () => {
      if (
        !isMountedRef.current ||
        focusRestoreIdRef.current !== focusRestoreId ||
        isEditorFocusedRef.current ||
        attemptsRemaining <= 0
      ) {
        return;
      }

      attemptsRemaining -= 1;
      input.editorRef.current?.focus();
      setTimeout(restoreFocus, 50);
    };
    requestAnimationFrame(restoreFocus);
  }, [input.editorRef]);

  /** Runs the queued restore once — whichever completion signal arrives first. */
  const runPendingDismissalRestore = useCallback(() => {
    if (!restorePendingRef.current) {
      return;
    }
    restorePendingRef.current = false;
    clearDismissRestoreTimer();
    // A reopened sheet owns focus again; drop the stale restore request.
    if (!isMountedRef.current || isActiveRef.current) {
      return;
    }
    restoreEditorFocus();
  }, [clearDismissRestoreTimer, restoreEditorFocus]);

  /**
   * Marks the sheet closed and queues the keyboard's return for the moment
   * the dismissal transition actually completes: the sheet slides away over a
   * resting composer, then the keyboard lifts it in one continuous motion.
   */
  const onDismissed = useCallback(() => {
    isActiveRef.current = false;
    setPhase("closed");

    if (!restoreFocusAfterDismissRef.current) {
      return;
    }
    restoreFocusAfterDismissRef.current = false;
    restorePendingRef.current = true;
    clearDismissRestoreTimer();
    if (Date.now() - lastStackTransitionFinishedAtRef.current <= NATIVE_DISMISSAL_ECHO_WINDOW_MS) {
      // A stack transition finished just before this pop reached JS: the pop
      // is the state echo of a gesture-driven dismissal whose animation has
      // already completed. The sheet is gone — bring the keyboard back now.
      runPendingDismissalRestore();
      return;
    }
    dismissRestoreTimerRef.current = setTimeout(() => {
      dismissRestoreTimerRef.current = null;
      runPendingDismissalRestore();
    }, SHEET_DISMISSAL_KEYBOARD_OVERLAP_MS);
  }, [clearDismissRestoreTimer, runPendingDismissalRestore]);

  /** Wire to the navigator's `finishTransitioning` event. */
  const onStackTransitionsFinished = useCallback(() => {
    lastStackTransitionFinishedAtRef.current = Date.now();
    runPendingDismissalRestore();
  }, [runPendingDismissalRestore]);

  return {
    isActive: phase !== "closed",
    isVisible: phase === "visible",
    open,
    onDismissed,
    onStackTransitionsFinished,
  } as const;
}
