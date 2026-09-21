import { Quaternion, Vector3 } from "three";

/** Shortest rotation vector. q and -q represent the same orientation. */
export function rotationVector(rotation: Quaternion) {
  const q = rotation.clone().normalize();
  if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
  const length = Math.hypot(q.x, q.y, q.z);
  return length < 1e-8
    ? new Vector3()
    : new Vector3(q.x, q.y, q.z).multiplyScalar((2 * Math.atan2(length, q.w)) / length);
}
function fromVector(vector: Vector3) {
  const angle = vector.length();
  return angle < 1e-8
    ? new Quaternion()
    : new Quaternion().setFromAxisAngle(vector.clone().divideScalar(angle), angle);
}

// Recovered from Bitrig 0.25's rotation dynamics: point gain, drag force limit,
// velocity limits, release prediction/blend, and the 0.5 / 0.78 release spring.
const gain = 0.006;
const response = 0.5;
const damping = 0.78;
const frequency = (2 * Math.PI) / response;
const decay = frequency * damping;
const stepSeconds = 1 / 120;

/** A moving spring target follows cumulative camera-space gestures; release latches the nearest useful view. */
export function createDuoMotion(options: { choose: (rotation: Quaternion) => Quaternion }) {
  const rotation = new Quaternion();
  const target = new Quaternion();
  const velocity = new Vector3();
  const gestureVelocity = new Vector3();
  let spring: { at: number; rotation: Quaternion; velocity: Vector3; steps: number } | null = null;
  let drag: {
    start: Quaternion;
    rest: Quaternion;
    x: number;
    y: number;
    error: Vector3;
    at: number;
  } | null = null;
  let pointer = false;
  let held = false;
  let interruptedDrag = false;
  let lastInput = -Infinity;
  const beginSpring = (next: Quaternion, now: number) => {
    target.copy(next).normalize();
    spring = {
      at: now,
      rotation: rotation.clone(),
      velocity: velocity.clone(),
      steps: 0,
    };
  };
  const release = (now: number) => {
    if (!drag) return;
    // A pause before lifting a pointer should not resurrect an old flick.
    if (now - lastInput > 100) gestureVelocity.set(0, 0, 0);
    const prediction = target
      .clone()
      .premultiply(fromVector(gestureVelocity.clone().multiplyScalar(0.085)));
    velocity.multiplyScalar(0.35).addScaledVector(gestureVelocity, 0.65).clampLength(0, 9);
    const moved = drag.x !== 0 || drag.y !== 0;
    const rest = drag.rest;
    drag = null;
    if (moved) beginSpring(options.choose(prediction), now);
    else beginSpring(rest, now);
  };
  const advance = (now: number, reduced = false) => {
    if (held || !Number.isFinite(now)) return false;
    if (drag && !pointer && now >= lastInput + 140) release(lastInput + 140);
    if (drag) {
      // Follow the target during the gesture. Retain the logarithm's winding so
      // a long drag cannot reverse its spring force when crossing a half turn.
      const seconds = Math.min(0.05, Math.max(0, (now - drag.at) / 1000));
      drag.at = now;
      const steps = Math.ceil(seconds * 120);
      const dt = steps ? seconds / steps : 0;
      for (let step = 0; step < steps; step++) {
        const error = rotationVector(target.clone().multiply(rotation.clone().invert()));
        if (error.lengthSq() > 1e-10) {
          const axis = error.clone().normalize();
          const turns = Math.round((drag.error.dot(axis) - error.length()) / (2 * Math.PI));
          error.addScaledVector(axis, turns * 2 * Math.PI);
        }
        drag.error.copy(error);
        const omega = (2 * Math.PI) / 0.68;
        const acceleration = error
          .clampLength(0, 1.2)
          .multiplyScalar(omega * omega)
          .addScaledVector(velocity, -2 * 1.12 * omega);
        velocity.addScaledVector(acceleration, dt).clampLength(0, 9);
        rotation.premultiply(fromVector(velocity.clone().multiplyScalar(dt))).normalize();
      }
      if (reduced) rotation.copy(target);
      return steps > 0 || reduced;
    }
    if (!spring) return false;
    const seconds = Math.max(0, (now - spring.at) / 1000);
    const steps = Math.min(240, Math.floor(seconds / stepSeconds));
    const integrate = (q: Quaternion, speed: Vector3, dt: number) => {
      const error = rotationVector(target.clone().multiply(q.clone().invert()));
      const acceleration = error
        .multiplyScalar(frequency * frequency)
        .addScaledVector(speed, -2 * decay);
      speed.addScaledVector(acceleration, dt).clampLength(0, 9);
      q.premultiply(fromVector(speed.clone().multiplyScalar(dt))).normalize();
    };
    // Fixed ticks make release independent of display refresh rate. The final
    // partial tick interpolates the next tick without committing it. This also
    // keeps displayed angular speed bounded between tick boundaries.
    for (; spring.steps < steps; spring.steps++)
      integrate(spring.rotation, spring.velocity, stepSeconds);
    rotation.copy(spring.rotation);
    velocity.copy(spring.velocity);
    const nextRotation = spring.rotation.clone();
    const nextVelocity = spring.velocity.clone();
    integrate(nextRotation, nextVelocity, stepSeconds);
    const fraction = Math.min(1, (seconds - steps * stepSeconds) / stepSeconds);
    rotation.slerp(nextRotation, fraction);
    velocity.lerp(nextVelocity, fraction);
    if (
      reduced ||
      steps === 240 ||
      (rotation.angleTo(target) < 0.0005 && velocity.length() < 0.005)
    ) {
      rotation.copy(target);
      velocity.set(0, 0, 0);
      spring = null;
    }
    return true;
  };
  const beginDrag = (now: number) => {
    if (held || drag) return;
    advance(now);
    drag = {
      start: rotation.clone(),
      rest: target.clone(),
      x: 0,
      y: 0,
      error: new Vector3(),
      at: now,
    };
    target.copy(rotation);
    gestureVelocity.set(0, 0, 0);
    lastInput = -Infinity;
    spring = null;
  };
  return {
    rotation,
    setPose(next: Quaternion, now: number, immediate = false) {
      advance(now);
      drag = null;
      pointer = false;
      beginSpring(next, now);
      if (immediate) {
        rotation.copy(target);
        velocity.set(0, 0, 0);
        spring = null;
      }
    },
    dragActive(active: boolean, now: number) {
      if (active) {
        beginDrag(now);
        pointer = true;
      } else {
        advance(now);
        pointer = false;
        release(now);
      }
    },
    /** Deltas are CSS pixels, independent of panel size and event partitioning. */
    orbit(x: number, y: number, now: number) {
      if (held || ![x, y, now].every(Number.isFinite) || (!x && !y)) return;
      advance(now);
      beginDrag(now);
      if (!drag) return;
      const previous = target.clone();
      drag.x += x;
      drag.y += y;
      target
        .copy(fromVector(new Vector3(drag.y * gain, drag.x * gain, 0)))
        .multiply(drag.start)
        .normalize();
      const seconds = (now - lastInput) / 1000;
      gestureVelocity.copy(rotationVector(target.clone().multiply(previous.invert())));
      if (seconds > 0 && seconds < 0.1) gestureVelocity.divideScalar(seconds).clampLength(0, 7.5);
      else gestureVelocity.set(0, 0, 0);
      lastInput = now;
    },
    /** Captured device touches and hinge edits freeze projection, independently of orbit dragging. */
    hold(active: boolean, now: number) {
      if (held === active) return;
      if (active) {
        interruptedDrag = drag !== null;
        drag = null;
        pointer = false;
        spring = null;
        velocity.set(0, 0, 0);
      }
      held = active;
      if (!active) {
        if (interruptedDrag) beginSpring(options.choose(target.clone()), now);
        else if (rotation.angleTo(target) > 0.0005) beginSpring(target, now);
        interruptedDrag = false;
      }
    },
    advance,
    needsFrame() {
      return (
        !held &&
        (spring !== null ||
          (drag !== null &&
            (!pointer || rotation.angleTo(target) > 0.0005 || velocity.length() > 0.005)))
      );
    },
    reset(next: Quaternion, now: number) {
      advance(now);
      drag = null;
      pointer = false;
      beginSpring(next, now);
    },
  };
}
