import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import { restoreFocusOnThreadEnter } from "../../lib/terminalFocus";

/** Restores thread focus, landing the caret a frame after composer entry. */
export function useFocusComposerOnThreadOpen(
  threadRef: ScopedThreadRef | null,
  root: HTMLElement | null,
  enabled: boolean,
  terminalOpen: boolean,
  focusComposer: () => void,
  preserveFocus?: () => boolean,
) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restores DOM focus on thread entry and after the drawer opens or closes
  useEffect(() => {
    if (!threadRef || !enabled || !root) return;
    let frame: number | undefined;
    const leave = restoreFocusOnThreadEnter(threadRef, {
      root,
      preserveFocus: preserveFocus?.() ?? false,
      focusComposer: () => {
        frame = window.requestAnimationFrame(() => {
          // Double-clicking a sidebar row opens its thread and its rename field in one gesture.
          if (document.activeElement?.matches("[data-sidebar-row] input")) return;
          focusComposer();
        });
      },
    });
    return () => {
      leave();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [
    threadRef,
    root,
    enabled,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Drawer visibility changes also restore focus after explicit open/close actions.
    terminalOpen,
    focusComposer,
    preserveFocus,
  ]);
}
