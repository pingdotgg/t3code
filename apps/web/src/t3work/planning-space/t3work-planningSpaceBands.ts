/**
 * Depth-band + scale mapping for the planning space (§3.2): band thresholds,
 * gauge labels, counter-scaling, and the subtask hour-stepper ladder. Split out
 * of t3work-planningSpaceScene.ts.
 */

import { FOCAL, Z_STORY } from "./t3work-planningSpaceScene";

export function epicCounterScale(scale: number): number {
  return Math.max(1, Math.min(5.5, 0.95 / scale));
}

/** Camera z that renders the story plane at exactly `scale` (§3.2 gauge). */
export function cameraZForStoryScale(scale: number): number {
  return FOCAL + Z_STORY - FOCAL / scale;
}

/** Depth bands (§3.2), keyed by projected story-plane scale. */
export type PlanningBand = 0 | 1 | 2 | 3 | 4 | 5;

export const BAND_THRESHOLDS = [0.3, 0.62, 0.92, 1.3, 1.8] as const;

export function bandForScale(scale: number): PlanningBand {
  if (scale < BAND_THRESHOLDS[0]) return 0;
  if (scale < BAND_THRESHOLDS[1]) return 1;
  if (scale < BAND_THRESHOLDS[2]) return 2;
  if (scale < BAND_THRESHOLDS[3]) return 3;
  if (scale < BAND_THRESHOLDS[4]) return 4;
  return 5;
}

/** Coarse band bucket for gauge chrome — avoids React rerenders between transitions. */
export function planningBandChromeBucket(band: number): number {
  if (band <= 0) return 0;
  if (band <= 2) return 1;
  if (band === 3) return 3;
  if (band === 4) return 4;
  return 5;
}

export function planningBandChromeChanged(prev: number, next: number): boolean {
  return (
    (prev < 5) !== (next < 5) || planningBandChromeBucket(prev) !== planningBandChromeBucket(next)
  );
}

export function planningGaugeActiveLabel(band: number): string {
  if (band <= 0) return "Epics";
  if (band <= 2) return "Stories";
  if (band === 3) return "Cards";
  if (band === 4) return "Tasks";
  return "Full";
}

/**
 * Counter-scaling (§3.2): inner content holds a minimum readable screen size
 * when zoomed out (bands 0–2) and a maximum at the planet band (5) so content
 * grows in area, not font size. Returns the inner scale multiplier.
 */
export function counterScale(band: PlanningBand, scale: number): number {
  switch (band) {
    case 0:
      return Math.max(1, Math.min(3.4, 0.8 / scale));
    case 1:
      return Math.max(1, Math.min(2.2, 0.8 / scale));
    case 2:
      return Math.max(1, 0.7 / scale);
    case 5:
      return Math.min(1, 1.3 / scale);
    default:
      return 1;
  }
}

/** Subtask hour-stepper ladder (§6.3), in seconds. */
export const HOUR_STEPS_SECONDS = [
  0, 1800, 3600, 7200, 10800, 14400, 21600, 28800, 36000, 43200, 57600, 72000, 86400,
] as const;

export function steppedHours(currentSeconds: number, direction: 1 | -1): number {
  const ladder = HOUR_STEPS_SECONDS;
  const top = ladder[ladder.length - 1] ?? 0;
  const exact = ladder.indexOf(currentSeconds as (typeof HOUR_STEPS_SECONDS)[number]);
  if (exact >= 0) {
    const next = Math.max(0, Math.min(ladder.length - 1, exact + direction));
    return ladder[next] ?? currentSeconds;
  }
  const ceiling = ladder.findIndex((v) => v > currentSeconds);
  if (direction > 0) {
    return ceiling < 0 ? top : (ladder[ceiling] ?? top);
  }
  return ceiling <= 0 ? 0 : (ladder[ceiling - 1] ?? 0);
}
