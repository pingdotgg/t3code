/**
 * Gauge scale interpolation math (piecewise-linear between anchor scales,
 * with a dynamic fit anchor). Extracted from t3work-PlanningSpaceView.tsx.
 */

import type { PlanningSpaceEngine } from "./t3work-planningSpaceRenderer";
import { Z_STORY, scaleForPlane } from "./t3work-planningSpaceScene";
import { GAUGE_ANCHOR_SCALES } from "./t3work-planningSpaceViewConstants";

/** Anchor scales incl. the dynamic fit ("All") scale, strictly ascending. */
export function planningGaugeAnchorScales(engine: PlanningSpaceEngine | null): number[] {
  const fitScale = engine ? scaleForPlane(engine.zMin, Z_STORY) : GAUGE_ANCHOR_SCALES[0] / 2;
  return [Math.min(fitScale, GAUGE_ANCHOR_SCALES[0] * 0.8), ...GAUGE_ANCHOR_SCALES];
}

/** Piecewise-linear position of `scale` between the evenly spaced labels. */
export function planningGaugeTForScale(engine: PlanningSpaceEngine | null, scale: number): number {
  const anchors = planningGaugeAnchorScales(engine);
  const segments = anchors.length - 1;
  if (scale <= (anchors[0] ?? 0)) return 0;
  for (let i = 0; i < segments; i++) {
    const low = anchors[i] ?? 0;
    const high = anchors[i + 1] ?? low + 1;
    if (scale <= high) {
      return (i + (scale - low) / (high - low)) / segments;
    }
  }
  return 1;
}

export function planningGaugeScaleForT(engine: PlanningSpaceEngine | null, t: number): number {
  const anchors = planningGaugeAnchorScales(engine);
  const segments = anchors.length - 1;
  const clamped = Math.max(0, Math.min(1, t));
  const position = clamped * segments;
  const index = Math.min(segments - 1, Math.floor(position));
  const low = anchors[index] ?? 0.1;
  const high = anchors[index + 1] ?? low + 1;
  return low + (position - index) * (high - low);
}
