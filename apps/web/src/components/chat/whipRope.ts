/**
 * Verlet rope for the draggable whip. Node 0 is the handle and follows the
 * pointer; the rest trail behind under gravity and distance constraints. The
 * tip picks up speed when the hand reverses, which is what a real crack is,
 * so tip speed is the crack detector.
 */
export interface Rope {
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly previousX: Float64Array;
  readonly previousY: Float64Array;
  readonly segmentLength: number;
}

const GRAVITY = 0.5;
const DAMPING = 0.985;
const CONSTRAINT_PASSES = 4;
/** Rope shape shared by the button and the tests: ~300px of whip. */
export const ROPE_NODES = 16;
export const SEGMENT_LENGTH = 20;
/**
 * Tip speed in px per 60Hz step that counts as a crack. Scales with the
 * rope: a longer lash reaches higher tip speeds from the same flick.
 */
export const CRACK_TIP_SPEED = 48;
/**
 * Hand speed in px per 60Hz step the flick must have reached shortly before
 * the tip peaks. A rope swinging on its own after a lazy move never cracks.
 */
export const FLICK_HAND_SPEED = 18;
/** Per-step decay of the remembered hand speed; ~10 steps to forget a flick. */
const HAND_MEMORY = 0.85;

export function createRope(nodes: number, segmentLength: number, x: number, y: number): Rope {
  const rope: Rope = {
    x: new Float64Array(nodes),
    y: new Float64Array(nodes),
    previousX: new Float64Array(nodes),
    previousY: new Float64Array(nodes),
    segmentLength,
  };
  for (let index = 0; index < nodes; index += 1) {
    rope.x[index] = x;
    rope.y[index] = y + index * segmentLength;
    rope.previousX[index] = x;
    rope.previousY[index] = rope.y[index]!;
  }
  return rope;
}

// ponytail: the typed arrays are updated in place so a 60Hz loop allocates
// nothing. The rope never leaves the button that owns it.
/**
 * Advances the rope one step. With an anchor the handle is pinned to it;
 * with `null` the whole rope is free and falls, keeping whatever velocity
 * the hand gave it.
 */
export function stepRope(rope: Rope, anchor: { x: number; y: number } | null): void {
  const { x, y, previousX, previousY, segmentLength } = rope;
  const nodes = x.length;
  const pinned = anchor !== null;
  for (let index = pinned ? 1 : 0; index < nodes; index += 1) {
    const velocityX = (x[index]! - previousX[index]!) * DAMPING;
    const velocityY = (y[index]! - previousY[index]!) * DAMPING + GRAVITY;
    previousX[index] = x[index]!;
    previousY[index] = y[index]!;
    x[index] = x[index]! + velocityX;
    y[index] = y[index]! + velocityY;
  }
  if (pinned) {
    previousX[0] = x[0]!;
    previousY[0] = y[0]!;
    x[0] = anchor.x;
    y[0] = anchor.y;
  }
  for (let pass = 0; pass < CONSTRAINT_PASSES; pass += 1) {
    for (let index = 0; index < nodes - 1; index += 1) {
      const deltaX = x[index + 1]! - x[index]!;
      const deltaY = y[index + 1]! - y[index]!;
      const distance = Math.hypot(deltaX, deltaY) || 0.0001;
      const correction = (distance - segmentLength) / distance;
      if (index === 0 && pinned) {
        x[1] = x[1]! - deltaX * correction;
        y[1] = y[1]! - deltaY * correction;
      } else {
        x[index] = x[index]! + deltaX * correction * 0.5;
        y[index] = y[index]! + deltaY * correction * 0.5;
        x[index + 1] = x[index + 1]! - deltaX * correction * 0.5;
        y[index + 1] = y[index + 1]! - deltaY * correction * 0.5;
      }
    }
  }
}

/** Highest node of the rope; past the bottom of the screen means it is gone. */
export function ropeTop(rope: Rope): number {
  let top = Infinity;
  for (let index = 0; index < rope.y.length; index += 1) top = Math.min(top, rope.y[index]!);
  return top;
}

export function tipSpeed(rope: Rope): number {
  const tip = rope.x.length - 1;
  return Math.hypot(rope.x[tip]! - rope.previousX[tip]!, rope.y[tip]! - rope.previousY[tip]!);
}

/** How far the hand moved on the last step. */
export function handSpeed(rope: Rope): number {
  return Math.hypot(rope.x[0]! - rope.previousX[0]!, rope.y[0]! - rope.previousY[0]!);
}

/**
 * A crack is the tip's speed peak after a real flick: the step where the tip
 * stops climbing past the threshold while the hand was fast a moment ago.
 * Feed it one (tip speed, hand speed) pair per step; it reports true on the
 * step right after the peak, once per swing. The hand dragging the tip up to
 * speed is not a crack, the rope swinging on its own is not a crack, and the
 * way back only counts if it peaks again.
 */
export function createSnapDetector(
  options: { tipThreshold?: number; handThreshold?: number } = {},
): (tipSpeed: number, handSpeed: number) => boolean {
  const tipThreshold = options.tipThreshold ?? CRACK_TIP_SPEED;
  const handThreshold = options.handThreshold ?? FLICK_HAND_SPEED;
  let previous = 0;
  let rising = false;
  let recentHand = 0;
  // Re-arms only once the tip has slowed to half the threshold, so the
  // jitter right after a crack cannot count as more peaks.
  let armed = true;
  return (speed, hand) => {
    recentHand = Math.max(hand, recentHand * HAND_MEMORY);
    const snapped =
      armed && rising && previous > tipThreshold && speed < previous && recentHand > handThreshold;
    if (snapped) armed = false;
    if (speed < tipThreshold / 2) armed = true;
    rising = speed > previous;
    previous = speed;
    return snapped;
  };
}
