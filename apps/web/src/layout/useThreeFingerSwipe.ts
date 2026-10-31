import type { LayoutKeybindingCommand } from "@t3tools/contracts";
import { useEffect } from "react";

import { getClientSettings } from "../hooks/useSettings";
import { registerMenuAction } from "../shortcuts/dispatcher";
import { isModalDialogOpen } from "../lib/modalDialog";
import { runLayoutCommand } from "./layoutCommands";

/**
 * Electron reports which way the fingers moved. Fingers left bring in the
 * column on the right, fingers up bring in the workspace below, like
 * dragging the strip itself.
 */
const SWIPE_COMMANDS: Record<string, LayoutKeybindingCommand> = {
  "layout-swipe-left": "layout.focusRight",
  "layout-swipe-right": "layout.focusLeft",
  "layout-swipe-up": "layout.focusWorkspaceDown",
  "layout-swipe-down": "layout.focusWorkspaceUp",
};

/**
 * Opt-in three-finger swipes on the macOS desktop app (Settings › Layout):
 * one flick moves one column or one workspace. Mounted with the layout host.
 */
export function useThreeFingerSwipe(active = true): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Register desktop swipe menu actions for the mounted layout host.
  useEffect(() => {
    if (!active) return;
    const disposers = Object.entries(SWIPE_COMMANDS).map(([action, command]) =>
      registerMenuAction(action, () => {
        if (getClientSettings().layoutThreeFingerSwipe === true && !isModalDialogOpen()) {
          runLayoutCommand(command);
        }
      }),
    );
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [active]);
}
