const ZOOM_STEPS = [0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8];

export function nextFileZoom(current: number, direction: -1 | 1, min: number, max: number) {
  const steps = ZOOM_STEPS.filter((step) => step >= min && step <= max);
  const next =
    direction === 1
      ? (steps.find((step) => step > current + 0.000001) ?? max)
      : (steps.findLast((step) => step < current - 0.000001) ?? min);
  return Math.min(max, Math.max(min, next));
}

/** A gesture crossing actual size lands there before further movement continues past it. */
export function pinchFileZoom(current: number, factor: number, min: number, max: number) {
  const next = Math.min(max, Math.max(min, current * factor));
  if (min <= 1 && max >= 1 && ((current < 1 && next >= 1) || (current > 1 && next <= 1))) return 1;
  return next;
}
