import type { DictationLevel } from "./dictationLevel";

/** Smallest bar scale; at the indicator's height a resting bar reads as a dot. */
export const WAVEFORM_REST_SCALE = 0.14;

// Levels below the gate are room noise; above it the remaining range is stretched to 0..1.
const NOISE_GATE = 0.18;
// Time constants for easing a bar toward its target: quick to rise, softer to fall.
const RISE_MS = 55;
const FALL_MS = 140;
// Below this distance from its target a bar counts as settled.
const SETTLE_EPSILON = 0.002;

// Draw only while recording or when level history changes.
export function driveDictationWaveform(
  bars: ReadonlyArray<HTMLElement>,
  level: DictationLevel,
): () => void {
  const count = bars.length;
  const center = (count - 1) / 2;
  const envelope = bars.map((_, index) => {
    const distance = Math.abs(index - center) / Math.max(1, center);
    return 0.4 + 0.6 * Math.cos((distance * Math.PI) / 2) ** 1.5;
  });
  // Distinct, fixed rates so neighbouring bars drift apart instead of moving in lockstep.
  const rates = bars.map((_, index) => 0.55 + ((index * 0.37) % 0.5));
  const history = new Float32Array(Math.ceil(center) + 1);
  const targets = new Float32Array(count).fill(WAVEFORM_REST_SCALE);
  const values = new Float32Array(count).fill(WAVEFORM_REST_SCALE);
  const written = new Float32Array(count).fill(-1);
  let pushes = 0;
  let frame: number | null = null;
  let lastTime = 0;

  const write = () => {
    for (let index = 0; index < count; index++) {
      const value = values[index]!;
      if (Math.abs(value - written[index]!) < 0.001) continue;
      written[index] = value;
      bars[index]!.style.transform = `scaleY(${value.toFixed(3)})`;
    }
  };

  const step = (time: number) => {
    const elapsed = Math.min(64, time - lastTime);
    lastTime = time;
    let moving = false;
    for (let index = 0; index < count; index++) {
      const value = values[index]!;
      const target = targets[index]!;
      const tau = target > value ? RISE_MS : FALL_MS;
      const next = value + (target - value) * (1 - Math.exp(-elapsed / tau));
      values[index] = Math.abs(target - next) < SETTLE_EPSILON ? target : next;
      if (values[index] !== target) moving = true;
    }
    write();
    frame = moving ? requestAnimationFrame(step) : null;
  };

  const onLevel = (raw: number) => {
    const gated = Math.max(0, (raw - NOISE_GATE) / (1 - NOISE_GATE));
    // Square root lifts quiet speech so normal talking fills most of the height.
    const loudness = Math.sqrt(Math.min(1, gated));
    // An exact 0 means capture stopped, and no further pushes will age the ripple out.
    if (raw <= 0) history.fill(0);
    else history.copyWithin(1, 0);
    history[0] = loudness;
    pushes += 1;
    for (let index = 0; index < count; index++) {
      const delayed = history[Math.round(Math.abs(index - center))]!;
      const variation = 0.78 + 0.22 * Math.sin(pushes * 0.45 * rates[index]! + index * 1.7);
      targets[index] = Math.max(
        WAVEFORM_REST_SCALE,
        Math.min(1, delayed * envelope[index]! * variation),
      );
    }
    if (frame === null) {
      lastTime = performance.now();
      frame = requestAnimationFrame(step);
    }
  };

  write();
  const unsubscribe = level.subscribe(onLevel);
  return () => {
    unsubscribe();
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
}
