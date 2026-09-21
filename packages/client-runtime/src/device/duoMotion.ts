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

/** Clock-driven quaternion spring. A release selects one target, which stays latched until interrupted. */
export function createDuoMotion(options: { choose: (rotation: Quaternion) => Quaternion }) {
  const rotation = new Quaternion();
  const target = new Quaternion();
  const velocity = new Vector3();
  let spring: { at: number; error: Vector3; velocity: Vector3 } | null = null;
  let held = false;
  let dirty = false;
  let lastInput = -Infinity;
  let zoom = 1;
  const beginSpring = (next: Quaternion, now: number) => {
    target.copy(next).normalize();
    spring = {
      at: now,
      error: rotationVector(rotation.clone().multiply(target.clone().invert())),
      velocity: velocity.clone(),
    };
    dirty = false;
  };
  return {
    rotation,
    get zoom() {
      return zoom;
    },
    setPose(next: Quaternion, now: number, immediate = false) {
      velocity.set(0, 0, 0);
      beginSpring(next, now);
      if (immediate) {
        rotation.copy(target);
        spring = null;
      }
    },
    orbit(x: number, y: number, now: number) {
      if (![x, y, now].every(Number.isFinite) || (!x && !y)) return;
      // Camera-space axes avoid the Euler pitch clamp and allow a device to stand after a sideways drag.
      const delta = fromVector(new Vector3(y * 3, x * 4, 0));
      rotation.premultiply(delta).normalize();
      const seconds = (now - lastInput) / 1000;
      velocity.copy(rotationVector(delta));
      if (seconds > 0 && seconds < 0.1) velocity.divideScalar(seconds).clampLength(0, 4);
      else velocity.set(0, 0, 0);
      lastInput = now;
      dirty = true;
      spring = null;
    },
    hold(active: boolean, now: number) {
      if (held === active) return;
      held = active;
      if (active) {
        spring = null;
        velocity.set(0, 0, 0);
      } else if (dirty) lastInput = now - 140;
      else if (rotation.angleTo(target) > 0.0005) beginSpring(target, now);
    },
    advance(now: number, reduced = false) {
      if (held) return false;
      if (dirty) {
        if (now < lastInput + 140) return false;
        beginSpring(options.choose(rotation.clone()), now);
      }
      if (!spring) return false;
      const seconds = Math.max(0, (now - spring.at) / 1000);
      const frequency = 12;
      const c = spring.velocity.clone().addScaledVector(spring.error, frequency);
      const error = spring.error
        .clone()
        .addScaledVector(c, seconds)
        .multiplyScalar(Math.exp(-frequency * seconds));
      const speed = spring.velocity
        .clone()
        .addScaledVector(c, -frequency * seconds)
        .multiplyScalar(Math.exp(-frequency * seconds));
      rotation.copy(fromVector(error)).multiply(target).normalize();
      if (reduced || (error.length() < 0.0005 && speed.length() < 0.005)) {
        rotation.copy(target);
        velocity.set(0, 0, 0);
        spring = null;
      }
      return true;
    },
    needsFrame() {
      return !held && (dirty || spring !== null);
    },
    zoomBy(delta: number) {
      if (Number.isFinite(delta))
        zoom = Math.exp(Math.max(Math.log(0.6), Math.min(Math.log(2.2), Math.log(zoom) + delta)));
    },
    reset(next: Quaternion, now: number) {
      zoom = 1;
      dirty = false;
      velocity.set(0, 0, 0);
      beginSpring(next, now);
    },
  };
}
