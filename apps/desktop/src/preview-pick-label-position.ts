/**
 * Pure clamp/flip math for the floating label that follows the cursor while
 * the user is picking an element in the in-app browser. Lives in its own
 * electron-free module so the geometry can be unit-tested without spinning
 * up an Electron preload context (`preview-pick-preload.ts` itself imports
 * `electron` and `react-grab/primitives`, which can't load under vitest).
 *
 * - Horizontally pins the label to `targetLeft`, clamped into
 *   `[VIEWPORT_MARGIN, viewportWidth - labelWidth - VIEWPORT_MARGIN]`.
 * - Vertically prefers above the target. If the label would overflow the
 *   top, flips below; if THAT also overflows the bottom, pins to the
 *   bottom margin (better to overlap the highlight than disappear).
 */

/** Distance in CSS pixels between the highlight and the floating label. */
export const LABEL_GAP = 4;
/** Minimum padding the label keeps from any viewport edge. */
export const VIEWPORT_MARGIN = 4;

export function computeLabelPosition(input: {
  targetLeft: number;
  targetTop: number;
  targetBottom: number;
  labelWidth: number;
  labelHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}): { x: number; y: number } {
  const { targetLeft, targetTop, targetBottom, labelWidth, labelHeight } = input;
  const { viewportWidth, viewportHeight } = input;

  let x = targetLeft;
  const maxX = viewportWidth - labelWidth - VIEWPORT_MARGIN;
  if (x > maxX) x = maxX;
  if (x < VIEWPORT_MARGIN) x = VIEWPORT_MARGIN;

  let y = targetTop - labelHeight - LABEL_GAP;
  if (y < VIEWPORT_MARGIN) {
    y = targetBottom + LABEL_GAP;
    if (y + labelHeight > viewportHeight - VIEWPORT_MARGIN) {
      y = Math.max(VIEWPORT_MARGIN, viewportHeight - labelHeight - VIEWPORT_MARGIN);
    }
  }

  return { x, y };
}
