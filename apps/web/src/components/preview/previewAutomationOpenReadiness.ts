import {
  FILL_PREVIEW_VIEWPORT,
  type PreviewAutomationOperation,
  type PreviewAutomationOpenInput,
  type PreviewSessionSnapshot,
  type PreviewViewportSetting,
} from "@t3tools/contracts";

/**
 * Viewport an agent-opened tab falls back to when the user has no configured
 * browser default. Agents screenshot and assert against what they open, so a
 * brand-new tab left in fill mode would be sized by whatever the panel happens
 * to be — deterministic beats incidental here.
 */
export const DEFAULT_PREVIEW_AUTOMATION_VIEWPORT = {
  _tag: "freeform",
  width: 1280,
  height: 800,
} as const satisfies PreviewViewportSetting;

/**
 * An explicit `open`/`show` is the agent deliberately surfacing or suppressing
 * its work, so it outranks the preference; the setting only decides what
 * happens when the agent said nothing either way.
 */
export function shouldOpenPreviewMiniPlayer(
  input: PreviewAutomationOpenInput,
  autoShowFloatingPreview = true,
): boolean {
  return input.open ?? input.show ?? autoShowFloatingPreview;
}

export function shouldAutoShowPreviewForAutomationUse(input: {
  readonly operation: PreviewAutomationOperation;
  readonly autoShowFloatingPreview: boolean;
  readonly presentationSuppressed: boolean;
}): boolean {
  return (
    input.operation !== "open" && input.autoShowFloatingPreview && !input.presentationSuppressed
  );
}

export function explicitlySuppressesPreviewMiniPlayer(input: PreviewAutomationOpenInput): boolean {
  return (input.open ?? input.show) === false;
}

export function previewAutomationOpenNeedsOverlay(
  input: PreviewAutomationOpenInput,
  snapshot: PreviewSessionSnapshot,
): boolean {
  return input.url !== undefined || snapshot.navStatus._tag !== "Idle";
}

/**
 * Whether a freshly opened automation tab still needs a viewport applied.
 *
 * A configured browser default is sent with `preview.open`, so the snapshot
 * already carries it and nothing is needed here. Fill means the user has no
 * stated preference, which is where the agent fallback applies.
 */
export function previewAutomationDefaultViewport(
  reusedExistingTab: boolean,
  snapshot: PreviewSessionSnapshot,
): PreviewViewportSetting | null {
  const viewport = snapshot.viewport ?? FILL_PREVIEW_VIEWPORT;
  return !reusedExistingTab && viewport._tag === "fill"
    ? DEFAULT_PREVIEW_AUTOMATION_VIEWPORT
    : null;
}
