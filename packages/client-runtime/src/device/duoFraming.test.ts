import { expect, it } from "vite-plus/test";
import { Box3, Vector3 } from "three";
import { createDuoFraming } from "./duoFraming.ts";

const box = (x: number, width: number) =>
  new Box3(new Vector3(x - width / 2, -1, -0.2), new Vector3(x + width / 2, 1, 0.2));
it("fits both axes through a moving pivot, freezes for contact, and stops once framing settles", () => {
  const framing = createDuoFraming();
  framing.setBounds(box(0, 1), Math.PI / 8, 0.7, 0);
  const initialDistance = framing.distance();
  const next = box(1.5, 3);
  framing.setBounds(next, Math.PI / 8, 0.7, 10);
  framing.advance(50);
  expect(framing.center.x).toBeGreaterThan(0);
  expect(framing.center.x).toBeLessThan(1.5);
  for (const x of [next.min.x, next.max.x])
    expect(
      Math.abs(x - framing.center.x) /
        ((framing.distance() - next.max.z) * Math.tan(Math.PI / 8) * 0.7),
    ).toBeLessThan(1);
  framing.hold(true, 50);
  const center = framing.center.clone(),
    distance = framing.distance();
  framing.advance(10000);
  expect(framing.center.equals(center)).toBe(true);
  expect(framing.distance()).toBe(distance);
  expect(framing.needsFrame()).toBe(false);
  framing.hold(false, 10000);
  framing.advance(10016);
  expect(framing.center.x).toBeLessThan(1.5);
  framing.advance(12000);
  expect(framing.center.x).toBe(1.5);
  expect(framing.distance()).toBeGreaterThan(initialDistance);
  expect(framing.needsFrame()).toBe(false);
});

it("uses elapsed time independently of frame partitions and fits a changed viewport immediately", () => {
  const run = (step: number) => {
    const framing = createDuoFraming();
    framing.setBounds(box(0, 1), Math.PI / 8, 1, 0);
    framing.setBounds(box(-1, 2), Math.PI / 8, 1, 0);
    for (let time = step; time < 400; time += step) framing.advance(time);
    framing.advance(400);
    return framing;
  };
  const fast = run(8),
    slow = run(33);
  expect(fast.center.distanceTo(slow.center)).toBeLessThan(1e-8);
  expect(fast.distance()).toBeCloseTo(slow.distance(), 8);
  fast.setBounds(box(-1, 2), Math.PI / 8, 0.4, 400, true);
  expect(fast.distance()).toBeGreaterThan(slow.distance());
  expect(fast.needsFrame()).toBe(false);
});
