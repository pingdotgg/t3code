import { useRef, useState, type RefObject } from "react";
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
  /** Runs on the frame the sheet becomes visible, after the keyboard started leaving. */
  readonly onPresent: () => void;
}) {
  // Destructured so the compiler keys memoized handlers on the stable editor ref, not on
  // the fresh input object: the finishTransitioning listener re-subscribes on every change.
  const { editorRef, onPresent } = input;
  const [phase, setPhase] = useState<PresentationPhase>("closed");
  const isActiveRef = useRef(false);
  // Written by the editor's focus handlers; read when restoring focus after dismissal.
  const isEditorFocusedRef = useRef(false);
  const openingIdRef = useRef(0);
  const focusRestoreIdRef = useRef(0);
  const restoreFocusAfterDismissRef = useRef(false);
  const restorePendingRef = useRef(false);
  const lastStackTransitionFinishedAtRef = useRef(0);
  const dismissRestoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearDismissRestoreTimer = () => {
    if (dismissRestoreTimerRef.current !== null) {
      clearTimeout(dismissRestoreTimerRef.current);
      dismissRestoreTimerRef.current = null;
    }
  };

  const open = () => {
    if (isActiveRef.current) {
      return;
    }

    isActiveRef.current = true;
    focusRestoreIdRef.current += 1;
    clearDismissRestoreTimer();
    restorePendingRef.current = false;
    restoreFocusAfterDismissRef.current =
      phase === "restoring" || isEditorFocusedRef.current || KeyboardController.isVisible();
    setPhase("opening");

    const openingId = openingIdRef.current + 1;
    openingIdRef.current = openingId;

    // Dismiss the keyboard before blur, then present next frame so native transitions overlap.
    void KeyboardController.dismiss({ animated: true });
    editorRef.current?.blur();

    requestAnimationFrame(() => {
      // A composer unmounted during the frame takes its editor with it; present nothing.
      if (
        !isActiveRef.current ||
        openingIdRef.current !== openingId ||
        editorRef.current === null
      ) {
        return;
      }
      setPhase("visible");
      onPresent();
    });
  };

  const restoreEditorFocus = () => {
    const focusRestoreId = focusRestoreIdRef.current + 1;
    focusRestoreIdRef.current = focusRestoreId;
    let attemptsRemaining = 20;

    // Retry focus restoration if UIKit briefly refuses first responder at the dismissal boundary.
    const restoreFocus = () => {
      if (focusRestoreIdRef.current !== focusRestoreId) {
        return;
      }
      if (isEditorFocusedRef.current || attemptsRemaining <= 0) {
        setPhase("closed");
        return;
      }

      attemptsRemaining -= 1;
      editorRef.current?.focus();
      setTimeout(restoreFocus, 50);
    };
    requestAnimationFrame(restoreFocus);
  };

  const runPendingDismissalRestore = () => {
    if (!restorePendingRef.current) {
      return;
    }
    restorePendingRef.current = false;
    clearDismissRestoreTimer();
    if (isActiveRef.current) {
      return;
    }
    restoreEditorFocus();
  };

  const onDismissed = () => {
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
  };

  const onStackTransitionsFinished = () => {
    lastStackTransitionFinishedAtRef.current = Date.now();
    runPendingDismissalRestore();
  };

  const onEditorFocusChange = (focused: boolean) => {
    isEditorFocusedRef.current = focused;
  };

  // Called when the composer unmounts: cancels a queued presentation frame, the
  // dismissal restore timer, and any focus-restore retries still in flight.
  const dispose = () => {
    isActiveRef.current = false;
    openingIdRef.current += 1;
    focusRestoreIdRef.current += 1;
    restorePendingRef.current = false;
    clearDismissRestoreTimer();
  };

  return {
    isActive: phase === "opening" || phase === "visible",
    keepsComposerExpanded: phase !== "closed",
    isVisible: phase === "visible",
    open,
    onEditorFocusChange,
    onDismissed,
    onStackTransitionsFinished,
    dispose,
  } as const;
}
