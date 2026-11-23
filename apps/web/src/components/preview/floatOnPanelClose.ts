import type { PreviewNavStatus } from "@t3tools/contracts";

/**
 * Closing the right panel floats its browser tab over the chat. A tab that was
 * only opened and never navigated still sits on about:blank, which reports an
 * Idle status; floating that leaves a blank panel with no address bar, so the
 * tab has nothing worth keeping on screen.
 */
export function floatsOnPanelClose(navStatus: PreviewNavStatus | undefined): boolean {
  return navStatus !== undefined && navStatus._tag !== "Idle";
}
