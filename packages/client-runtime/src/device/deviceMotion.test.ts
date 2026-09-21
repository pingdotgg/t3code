import { expect, it, vi } from "vite-plus/test";
import { Quaternion, Vector3 } from "three";
import { createDeviceMotion, rotationVector } from "./deviceMotion.ts";
import { nearestDeviceView } from "./deviceViewSnap.ts";

const snaps = ["portrait", "landscape_left", "portrait_upside_down", "landscape_right"].map(
  (orientation, index) => ({
    orientation,
    rotation: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), (-index * Math.PI) / 2),
    yawLimit: Math.PI / 3,
  }),
);
const rotation = (x: number, y: number, z = 0) =>
  new Quaternion().setFromAxisAngle(new Vector3(x, y, z).normalize(), Math.hypot(x, y, z));

it("selects the nearest quarter turn, retains a nearby yaw, and treats quaternion signs identically", () => {
  const side = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -Math.PI / 2);
  const released = side.clone().premultiply(rotation(0, 0.4));
  const nearest = nearestDeviceView(released, snaps)!;
  expect(nearest.orientation).toBe("landscape_left");
  expect(nearest.rotation.angleTo(released)).toBeLessThan(1e-6);
  const negative = released.clone().set(-released.x, -released.y, -released.z, -released.w);
  expect(nearestDeviceView(negative, snaps)!.rotation.angleTo(nearest.rotation)).toBeLessThan(1e-6);
  expect(
    nearestDeviceView(rotation(0, 3), snaps)!.rotation.angleTo(new Quaternion()),
  ).toBeLessThanOrEqual(Math.PI / 3 + 1e-6);
});

it("springs toward a cumulative drag without teleporting and keeps the same target across event partitions", () => {
  const run = (parts: number) => {
    const choose = vi.fn((q: Quaternion) => q);
    const motion = createDeviceMotion({ choose });
    motion.dragActive(true, 0);
    for (let part = 0; part < parts; part++) motion.orbit(160 / parts, 80 / parts, 0);
    expect(motion.rotation.angleTo(new Quaternion())).toBeLessThan(1e-6);
    for (let time = 8; time <= 400; time += 8) motion.advance(time);
    expect(motion.rotation.angleTo(new Quaternion())).toBeGreaterThan(0.5);
    motion.dragActive(false, 400);
    for (let time = 408; time <= 2400; time += 8) motion.advance(time);
    expect(choose).toHaveBeenCalledOnce();
    expect(motion.needsFrame()).toBe(false);
    return motion.rotation;
  };
  expect(run(1).angleTo(run(20))).toBeLessThan(1e-6);
});

it("selects the predicted nearest view once and preserves velocity when interrupted", () => {
  const choose = vi.fn((q: Quaternion) => nearestDeviceView(q, snaps)!.rotation);
  const motion = createDeviceMotion({ choose });
  motion.dragActive(true, 0);
  motion.orbit(0, 240, 0);
  motion.orbit(0, 20, 20);
  motion.advance(40);
  motion.dragActive(false, 40);
  const before = motion.rotation.clone();
  motion.advance(80);
  expect(motion.rotation.angleTo(before)).toBeGreaterThan(0.01);
  const interrupted = motion.rotation.clone();
  motion.dragActive(true, 80);
  expect(motion.rotation.angleTo(interrupted)).toBeLessThan(1e-6);
  motion.orbit(30, -30, 80);
  motion.advance(96);
  motion.dragActive(false, 100);
  for (let time = 116; time <= 2500; time += 16) motion.advance(time);
  expect(choose).toHaveBeenCalledTimes(2);
  expect(motion.needsFrame()).toBe(false);
});

it("release uses elapsed time equally at different frame rates and a captured contact freezes projection", () => {
  const run = (step: number) => {
    const motion = createDeviceMotion({ choose: () => new Quaternion() });
    motion.dragActive(true, 0);
    motion.orbit(160, 80, 0);
    motion.advance(50);
    motion.dragActive(false, 50);
    for (let time = 50; time < 450; time += step) motion.advance(time);
    motion.advance(450);
    return motion;
  };
  const fast = run(8),
    slow = run(33),
    throttled = run(1000);
  expect(fast.rotation.angleTo(slow.rotation)).toBeLessThan(1e-6);
  expect(fast.rotation.angleTo(throttled.rotation)).toBeLessThan(1e-6);
  fast.hold(true, 450);
  const contact = fast.rotation.clone();
  fast.orbit(100, 100, 500);
  fast.advance(10000);
  expect(fast.rotation.angleTo(contact)).toBeLessThan(1e-6);
  fast.hold(false, 10000);
  fast.advance(12000);
  expect(fast.needsFrame()).toBe(false);
});

it("waits for trackpad quiet, handles reduced motion and invalid deltas, and settles without idle frames", () => {
  const choose = vi.fn(() => new Quaternion());
  const motion = createDeviceMotion({ choose });
  motion.orbit(NaN, 0, 0);
  expect(motion.needsFrame()).toBe(false);
  motion.orbit(200, 100, 0);
  motion.advance(100);
  expect(choose).not.toHaveBeenCalled();
  expect(motion.rotation.angleTo(new Quaternion())).toBeGreaterThan(0);
  motion.advance(140, true);
  expect(choose).toHaveBeenCalledOnce();
  expect(motion.rotation.angleTo(new Quaternion())).toBeLessThan(1e-6);
  expect(motion.needsFrame()).toBe(false);
  expect(rotationVector(rotation(0, Math.PI)).length()).toBeCloseTo(Math.PI);
});

it("keeps release angular speed bounded even across a back-facing half turn", () => {
  const motion = createDeviceMotion({ choose: () => rotation(0, Math.PI) });
  motion.setPose(rotation(0, Math.PI), 0);
  let previous = motion.rotation.clone();
  for (let time = 8; time <= 1600; time += 8) {
    motion.advance(time);
    expect(motion.rotation.angleTo(previous)).toBeLessThanOrEqual(9 * 0.008 + 1e-5);
    previous = motion.rotation.clone();
  }
  expect(motion.rotation.angleTo(rotation(0, Math.PI))).toBeLessThan(1e-6);
  expect(motion.needsFrame()).toBe(false);
});

it("a click without dragging resumes the interrupted resting view instead of stranding the device", () => {
  const choose = vi.fn(() => new Quaternion());
  const motion = createDeviceMotion({ choose });
  const rest = rotation(0, 0.8);
  motion.setPose(rest, 0);
  motion.advance(50);
  motion.dragActive(true, 50);
  motion.advance(60);
  motion.dragActive(false, 60);
  motion.advance(2100);
  expect(motion.rotation.angleTo(rest)).toBeLessThan(1e-6);
  expect(choose).not.toHaveBeenCalled();
  expect(motion.needsFrame()).toBe(false);
});
