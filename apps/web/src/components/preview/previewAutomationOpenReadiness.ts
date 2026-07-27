import type { PreviewAutomationOpenInput, PreviewSessionSnapshot } from "@t3tools/contracts";

export interface PreviewAutomationOpenWaitPolicy {
  readonly acknowledgeAfterCreation: boolean;
  readonly waitForOverlay: boolean;
  readonly waitForVisibility: boolean;
}

export function shouldOpenPreviewMiniPlayer(input: PreviewAutomationOpenInput): boolean {
  return input.open ?? input.show ?? true;
}

export function previewAutomationOpenNeedsOverlay(
  input: PreviewAutomationOpenInput,
  snapshot: PreviewSessionSnapshot,
): boolean {
  return input.url !== undefined || snapshot.navStatus._tag !== "Idle";
}

export function resolvePreviewAutomationOpenWaitPolicy(
  input: PreviewAutomationOpenInput,
  snapshot: PreviewSessionSnapshot,
  reusedExistingTab: boolean,
): PreviewAutomationOpenWaitPolicy {
  if (!reusedExistingTab) {
    return {
      acknowledgeAfterCreation: true,
      waitForOverlay: false,
      waitForVisibility: false,
    };
  }
  const canPresentBrowserSurface =
    input.url !== undefined ||
    snapshot.navStatus._tag === "Loading" ||
    snapshot.navStatus._tag === "Success";
  return {
    acknowledgeAfterCreation: false,
    waitForOverlay: previewAutomationOpenNeedsOverlay(input, snapshot),
    waitForVisibility: shouldOpenPreviewMiniPlayer(input) && canPresentBrowserSurface,
  };
}
