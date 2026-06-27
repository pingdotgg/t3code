import type { PreviewAutomationOpenInput, PreviewSessionSnapshot } from "@t3tools/contracts";

export function previewAutomationOpenNeedsOverlay(
  _input: PreviewAutomationOpenInput,
  _snapshot: PreviewSessionSnapshot,
): boolean {
  // A blank tab still needs its native WebContents before follow-up status,
  // evaluation, or navigation can be reliable. Returning from open before the
  // desktop surface exists creates a race that only background tabs tend to hit.
  return true;
}
