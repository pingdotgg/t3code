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

export function shouldPresentPreview(input: PreviewAutomationOpenInput): boolean {
  return input.open ?? input.show ?? true;
}

/** Full settle budget while waiting for a routed browser surface to paint. */
export const PREVIEW_PRESENTATION_SETTLE_TIMEOUT_MS = 500;

/**
 * Grace period for a mounted surface to claim the tab. Background-thread opens
 * never mount a panel, so waiting the full settle budget only burns latency.
 */
export const PREVIEW_PRESENTATION_CLAIM_GRACE_MS = 64;

export type PreviewPresentationSettleDecision = "continue" | "done";

/**
 * Decide whether presentation settle should keep polling.
 * - done immediately when the surface is already visible
 * - done after claim grace when no owner has claimed the tab (not routed)
 * - done at the full timeout otherwise
 */
export function previewPresentationSettleDecision(input: {
  readonly visible: boolean;
  readonly claimed: boolean;
  readonly elapsedMs: number;
  readonly claimGraceMs?: number;
  readonly timeoutMs?: number;
}): PreviewPresentationSettleDecision {
  if (input.visible) return "done";
  const timeoutMs = input.timeoutMs ?? PREVIEW_PRESENTATION_SETTLE_TIMEOUT_MS;
  if (input.elapsedMs >= timeoutMs) return "done";
  const claimGraceMs = input.claimGraceMs ?? PREVIEW_PRESENTATION_CLAIM_GRACE_MS;
  if (!input.claimed && input.elapsedMs >= claimGraceMs) return "done";
  return "continue";
}

export function previewAutomationOpenNeedsOverlay(
  input: PreviewAutomationOpenInput,
  snapshot: PreviewSessionSnapshot,
): boolean {
  return input.url !== undefined || snapshot.navStatus._tag !== "Idle";
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
