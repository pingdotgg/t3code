import { expect, it, vi } from "vite-plus/test";
import { Quaternion, Vector3 } from "three";
import { createDuoMotion, rotationVector } from "./duoMotion.ts";
import { duoViewSnaps, nearestDuoView } from "./duoSnap.ts";

const frames = [
  {
    face: "inside" as const,
    normal: new Vector3(0, 0, 1),
    up: new Vector3(0, 1, 0),
    center: new Vector3(),
  },
];
const snaps = duoViewSnaps(frames, 1);
const rotation = (x: number, y: number, z = 0) =>
  new Quaternion().setFromAxisAngle(new Vector3(x, y, z).normalize(), Math.hypot(x, y, z));

it("selects the nearest quarter turn, retains a nearby yaw, and treats quaternion signs identically", () => {
  const side = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -Math.PI / 2);
  const released = side.clone().premultiply(rotation(0, 0.4));
  const nearest = nearestDuoView(released, snaps)!;
  expect(nearest.orientation).toBe("landscape_left");
  expect(nearest.rotation.angleTo(released)).toBeLessThan(1e-6);
  const negative = released.clone().set(-released.x, -released.y, -released.z, -released.w);
  expect(nearestDuoView(negative, snaps)!.rotation.angleTo(nearest.rotation)).toBeLessThan(1e-6);
  expect(
    nearestDuoView(rotation(0, 3), snaps)!.rotation.angleTo(new Quaternion()),
  ).toBeLessThanOrEqual(Math.PI / 3 + 1e-6);
});

it("chooses a leaf-focused seated view when it is closer than the middle of the fold", () => {
  const leaf = {
    face: "right" as const,
    normal: new Vector3(0.6, 0, 0.8),
    up: new Vector3(0, 1, 0),
    center: new Vector3(1, 0, 0),
  };
  const candidates = duoViewSnaps([...frames, leaf], 3);
  const seat = candidates.find(
    (candidate) => candidate.face === "right" && candidate.orientation === "portrait",
  )!;
  const released = seat.rotation.clone().premultiply(rotation(0.04, 0.05));
  const chosen = nearestDuoView(released, candidates)!;
  expect(chosen.face).toBe("right");
  expect(chosen.orientation).toBe("portrait");
  expect(chosen.center.x).toBe(1);
});

it("allows free inspection while held, latches the closest release target, and never changes zoom while settling", () => {
  const choose = vi.fn((q: Quaternion) => nearestDuoView(q, snaps)!.rotation);
  const motion = createDuoMotion({ choose });
  motion.zoomBy(0.3);
  const zoom = motion.zoom;
  motion.hold(true, 0);
  motion.orbit(0.7, 0.8, 0);
  const released = motion.rotation.clone();
  expect(motion.advance(10000)).toBe(false);
  expect(motion.rotation.angleTo(released)).toBeLessThan(1e-6);
  motion.hold(false, 10000);
  motion.advance(10000);
  const selected = nearestDuoView(released, snaps)!;
  for (let time = 10016; time <= 12000; time += 16) motion.advance(time);
  expect(choose).toHaveBeenCalledOnce();
  expect(motion.rotation.angleTo(selected.rotation)).toBeLessThan(1e-6);
  expect(motion.zoom).toBe(zoom);
  expect(motion.needsFrame()).toBe(false);
});

it("settles equally with fast, slow and throttled frames, waits for trackpad quiet, and freezes for a screen contact", () => {
  const run = (step: number) => {
    const motion = createDuoMotion({ choose: () => new Quaternion() });
    motion.orbit(0.25, 0.4, 0);
    const drag = motion.rotation.clone();
    motion.advance(100);
    expect(motion.rotation.angleTo(drag)).toBeLessThan(1e-6);
    motion.advance(140);
    for (let time = 140; time < 700; time += step) motion.advance(time);
    motion.advance(700);
    return motion;
  };
  const fast = run(8),
    slow = run(33),
    throttled = run(1000);
  expect(fast.rotation.angleTo(slow.rotation)).toBeLessThan(1e-6);
  expect(fast.rotation.angleTo(throttled.rotation)).toBeLessThan(1e-6);
  fast.hold(true, 700);
  const contact = fast.rotation.clone();
  fast.advance(10000);
  expect(fast.rotation.angleTo(contact)).toBeLessThan(1e-6);
  fast.hold(false, 10000);
  fast.advance(12000);
  expect(fast.needsFrame()).toBe(false);
});

it("supports reduced motion, bounded release velocity, invalid deltas, and exact half-turn rotations", () => {
  const motion = createDuoMotion({ choose: () => new Quaternion() });
  motion.orbit(NaN, 0, 0);
  motion.zoomBy(Infinity);
  expect(motion.needsFrame()).toBe(false);
  motion.hold(true, 0);
  motion.orbit(0.2, 0, 0);
  motion.orbit(0.2, 0, 1);
  const released = motion.rotation.clone();
  motion.advance(10000, true);
  expect(motion.rotation.angleTo(released)).toBeLessThan(1e-6);
  motion.hold(false, 10000);
  motion.advance(10000, true);
  expect(motion.rotation.angleTo(new Quaternion())).toBeLessThan(1e-6);
  expect(motion.needsFrame()).toBe(false);
  expect(rotationVector(rotation(0, Math.PI)).length()).toBeCloseTo(Math.PI);
});
