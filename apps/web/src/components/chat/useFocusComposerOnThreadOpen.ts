import { useEffect } from "react";

/** Lands the caret in the composer a frame after a thread opens. */
export function useFocusComposerOnThreadOpen(
  threadId: string | undefined,
  enabled: boolean,
  focusComposer: () => void,
) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- schedules a frame to focus the composer DOM element when a thread opens with the terminal closed
  useEffect(() => {
    if (!threadId || !enabled) return;
    const frame = window.requestAnimationFrame(() => {
      // Double-clicking a sidebar row opens its thread and its rename field in one gesture.
      if (document.activeElement?.matches("[data-sidebar-row] input")) return;
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [threadId, enabled, focusComposer]);
}
