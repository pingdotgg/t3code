import {
  FILL_PREVIEW_VIEWPORT,
  type PreviewAutomationOpenInput,
  type PreviewSessionSnapshot,
  type PreviewViewportSetting,
} from "@t3tools/contracts";

export const DEFAULT_PREVIEW_AUTOMATION_VIEWPORT = {
  _tag: "freeform",
  width: 1280,
  height: 800,
} as const satisfies PreviewViewportSetting;

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

export function previewAutomationDefaultViewport(
  reusedExistingTab: boolean,
  snapshot: PreviewSessionSnapshot,
): PreviewViewportSetting | null {
  const viewport = snapshot.viewport ?? FILL_PREVIEW_VIEWPORT;
  return !reusedExistingTab && viewport._tag === "fill"
    ? DEFAULT_PREVIEW_AUTOMATION_VIEWPORT
    : null;
}
