/**
 * Pure layout and timing rules for the voice overlay, split out of the panel
 * component so behavior tests run in plain Node (the repo's controller-test
 * pattern).
 */
import type { VoiceOverlayPosition } from "./overlayPreferences";

/** Minimum distance between the overlay and the viewport edge. */
const EDGE_MARGIN = 8;

/** Clamps an overlay top-left position so the whole box stays on screen. */
export function clampVoiceOverlayPosition(
  position: VoiceOverlayPosition,
  size: { readonly width: number; readonly height: number },
  viewportWidth: number,
  viewportHeight: number,
): VoiceOverlayPosition {
  const maxX = Math.max(EDGE_MARGIN, viewportWidth - EDGE_MARGIN - size.width);
  const maxY = Math.max(EDGE_MARGIN, viewportHeight - EDGE_MARGIN - size.height);
  return {
    x: Math.min(Math.max(EDGE_MARGIN, position.x), maxX),
    y: Math.min(Math.max(EDGE_MARGIN, position.y), maxY),
  };
}

/** Collapse the expanded panel back to the corner button after this much
    time with no session activity (transcript deltas, tool marks, state
    changes) while a live session runs. */
export const VOICE_AUTO_COLLAPSE_MS = 15_000;

export interface VoiceAutoCollapseInput {
  readonly expanded: boolean;
  readonly phase: string;
  readonly inFlightTool: string | null;
  /** Epoch ms of the last session activity; 0 means "no activity yet". */
  readonly lastActivityAt: number;
  readonly now: number;
}

export function shouldAutoCollapseVoiceOverlay(input: VoiceAutoCollapseInput): boolean {
  return (
    input.expanded &&
    input.phase === "live" &&
    input.inFlightTool === null &&
    input.lastActivityAt > 0 &&
    input.now - input.lastActivityAt >= VOICE_AUTO_COLLAPSE_MS
  );
}

/** Movement beyond this many pixels turns a press on the corner button into
    a drag instead of a tap or a push-to-talk hold. */
export const VOICE_DRAG_THRESHOLD_PX = 4;

/** A press held at least this long on the corner button counts as
    push-to-talk in hold mode; a shorter press is a tap (expand). */
export const VOICE_HOLD_MS = 200;
