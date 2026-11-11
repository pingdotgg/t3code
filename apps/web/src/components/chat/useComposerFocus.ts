import type { ComposerHandleRef } from "../../composerHandleContext";
import { useStableCallback } from "../../hooks/useStableCallback";
import { isModelPickerOpen } from "../../modelPickerVisibility";

/**
 * Made outside ChatView's render: a memoized closure there keeps that render's scope, thread
 * projection included, and the scope keeps the previous render's, so every thread copy
 * ChatView showed stayed in memory until it unmounted.
 */
export function useComposerFocus(composerRef: ComposerHandleRef) {
  const focusComposer = useStableCallback(() => {
    composerRef.current?.focusAtEnd();
  });
  const scheduleComposerFocus = useStableCallback(() => {
    window.requestAnimationFrame(() => {
      // The model picker stays open through its own changes, so it keeps focus.
      if (!isModelPickerOpen()) focusComposer();
    });
  });
  return { focusComposer, scheduleComposerFocus };
}
