import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { KeyboardController } from "react-native-keyboard-controller";

import type { ComposerEditorHandle } from "../../components/ComposerEditor";

type PresentationPhase = "closed" | "opening" | "visible" | "restoring";

/** UIKit completion event from the native-stack patch; absent from upstream event maps. */
export type NavigationWithFinishTransitioning = {
  readonly addListener: (type: "finishTransitioning", callback: () => void) => () => void;
};

const SHEET_DISMISSAL_KEYBOARD_OVERLAP_MS = 300;

/** Gesture dismissal completes before router pop; recent completion means keyboard restoration need not wait again. */
const NATIVE_DISMISSAL_ECHO_WINDOW_MS = 150;

/** Blur/focus costs two keyboard animations; inputView overrides also replay show when removed. */
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
    restoreFocusAfterDismissRef.current =
      phase === "restoring" || input.isEditorFocused || KeyboardController.isVisible();
    setPhase("opening");

    const openingId = openingIdRef.current + 1;
    openingIdRef.current = openingId;

    // Dismiss the keyboard before blur, then present next frame so native transitions overlap.
    void KeyboardController.dismiss({ animated: true });
    input.editorRef.current?.blur();

    requestAnimationFrame(() => {
      if (!isMountedRef.current || !isActiveRef.current || openingIdRef.current !== openingId) {
        return;
      }
      setPhase("visible");
    });
  }, [clearDismissRestoreTimer, input.editorRef, input.isEditorFocused, phase]);

  const restoreEditorFocus = useCallback(() => {
    const focusRestoreId = focusRestoreIdRef.current + 1;
    focusRestoreIdRef.current = focusRestoreId;
    let attemptsRemaining = 20;

    // Retry focus restoration if UIKit briefly refuses first responder at the dismissal boundary.
    const restoreFocus = () => {
      if (!isMountedRef.current || focusRestoreIdRef.current !== focusRestoreId) {
        return;
      }
      if (isEditorFocusedRef.current || attemptsRemaining <= 0) {
        setPhase("closed");
        return;
      }

      attemptsRemaining -= 1;
      input.editorRef.current?.focus();
      setTimeout(restoreFocus, 50);
    };
    requestAnimationFrame(restoreFocus);
  }, [input.editorRef]);

  const runPendingDismissalRestore = useCallback(() => {
    if (!restorePendingRef.current) {
      return;
    }
    restorePendingRef.current = false;
    clearDismissRestoreTimer();
    if (!isMountedRef.current || isActiveRef.current) {
      return;
    }
    restoreEditorFocus();
  }, [clearDismissRestoreTimer, restoreEditorFocus]);

  const onDismissed = useCallback(() => {
    isActiveRef.current = false;

    if (!restoreFocusAfterDismissRef.current) {
      setPhase("closed");
      return;
    }
    // Keep the card expanded during focus handoff; hardware keyboards cannot hide a collapse with keyboard travel.
    setPhase("restoring");
    restoreFocusAfterDismissRef.current = false;
    restorePendingRef.current = true;
    clearDismissRestoreTimer();
    if (Date.now() - lastStackTransitionFinishedAtRef.current <= NATIVE_DISMISSAL_ECHO_WINDOW_MS) {
      runPendingDismissalRestore();
      return;
    }
    dismissRestoreTimerRef.current = setTimeout(() => {
      dismissRestoreTimerRef.current = null;
      runPendingDismissalRestore();
    }, SHEET_DISMISSAL_KEYBOARD_OVERLAP_MS);
  }, [clearDismissRestoreTimer, runPendingDismissalRestore]);

  const onStackTransitionsFinished = useCallback(() => {
    lastStackTransitionFinishedAtRef.current = Date.now();
    runPendingDismissalRestore();
  }, [runPendingDismissalRestore]);

  return {
    isActive: phase === "opening" || phase === "visible",
    keepsComposerExpanded: phase !== "closed",
    isVisible: phase === "visible",
    open,
    onDismissed,
    onStackTransitionsFinished,
  } as const;
}
