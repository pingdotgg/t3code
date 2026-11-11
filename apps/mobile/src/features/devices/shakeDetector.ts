export interface AccelerationSample {
  /** Acceleration per axis in g, gravity included. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly timestamp: number;
}

export function createShakeDetector({
  threshold = 1.8,
  window = 600,
  cooldown = 1_000,
}: { threshold?: number; window?: number; cooldown?: number } = {}) {
  let jolts: number[] = [];
  let lastShake = Number.NEGATIVE_INFINITY;
  return (sample: AccelerationSample) => {
    if (sample.timestamp - lastShake < cooldown) return false;
    if (Math.hypot(sample.x, sample.y, sample.z) < threshold) return false;
    jolts = [...jolts.filter((time) => sample.timestamp - time <= window), sample.timestamp];
    if (jolts.length < 2) return false;
    jolts = [];
    lastShake = sample.timestamp;
    return true;
  };
}
