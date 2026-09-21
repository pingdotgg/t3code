import { Box3, Vector3 } from "three";

/** Fit the current assembly, with independent framing dynamics so a leaf pivot does not drag it off-screen. */
export function createDuoFraming() {
  const center = new Vector3();
  const target = new Vector3();
  const velocity = new Vector3();
  const bounds = new Box3();
  let distance = 1;
  let targetDistance = 1;
  let distanceVelocity = 0;
  let tanX = 1;
  let tanY = 1;
  let at = 0;
  let initialized = false;
  let moving = false;
  let held = false;
  const advance = (now: number, immediate = false) => {
    if (held) return false;
    const dt = Math.max(0, (now - at) / 1000);
    at = now;
    if (!moving) return false;
    const omega = 14;
    const decay = Math.exp(-omega * dt);
    const error = center.clone().sub(target);
    const coefficient = velocity.clone().addScaledVector(error, omega);
    center.copy(error).addScaledVector(coefficient, dt).multiplyScalar(decay).add(target);
    velocity.addScaledVector(coefficient, -omega * dt).multiplyScalar(decay);
    const distanceError = distance - targetDistance;
    const distanceCoefficient = distanceVelocity + omega * distanceError;
    distance = targetDistance + (distanceError + distanceCoefficient * dt) * decay;
    distanceVelocity = (distanceVelocity - omega * distanceCoefficient * dt) * decay;
    moving =
      center.distanceTo(target) > 0.0005 ||
      velocity.length() > 0.005 ||
      Math.abs(distance - targetDistance) > 0.0005 ||
      Math.abs(distanceVelocity) > 0.005;
    if (immediate || !moving) {
      center.copy(target);
      distance = targetDistance;
      velocity.set(0, 0, 0);
      distanceVelocity = 0;
      moving = false;
    }
    return true;
  };
  return {
    center,
    setBounds(next: Box3, vertical: number, aspect: number, now: number, immediate = false) {
      if (next.isEmpty()) return;
      advance(now);
      bounds.copy(next);
      tanY = Math.tan(vertical);
      tanX = tanY * aspect;
      bounds.getCenter(target);
      target.z = 0;
      const size = bounds.getSize(new Vector3());
      targetDistance = Math.max(1, Math.max(size.x / tanX, size.y / tanY) * 0.565 + bounds.max.z);
      moving = true;
      advance(now, immediate || !initialized);
      initialized = true;
    },
    advance,
    distance() {
      // Spring lag must never clip the default fit. Explicit user zoom may go beyond it.
      const clearance = Math.max(
        Math.abs(bounds.min.x - center.x) / tanX,
        Math.abs(bounds.max.x - center.x) / tanX,
        Math.abs(bounds.min.y - center.y) / tanY,
        Math.abs(bounds.max.y - center.y) / tanY,
      );
      return Math.max(distance, clearance * 1.02 + bounds.max.z, 1);
    },
    hold(active: boolean, now: number) {
      held = active;
      at = now;
    },
    needsFrame() {
      return moving && !held;
    },
  };
}
