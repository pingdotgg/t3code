import type { PreviewAutomationOpenInput, PreviewSessionSnapshot } from "@t3tools/contracts";

export interface PreviewAutomationOpenWaitPolicy {
  readonly acknowledgeAfterCreation: boolean;
  readonly waitForOverlay: boolean;
  readonly waitForVisibility: boolean;
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
    waitForOverlay: input.url !== undefined || snapshot.navStatus._tag !== "Idle",
    waitForVisibility: (input.show ?? true) && canPresentBrowserSurface,
  };
}
