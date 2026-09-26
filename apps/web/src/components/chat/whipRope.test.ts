import { describe, expect, it } from "vite-plus/test";

import {
  CRACK_TIP_SPEED,
  createRope,
  createSnapDetector,
  handSpeed,
  ROPE_NODES as NODES,
  ropeTop,
  SEGMENT_LENGTH as SEGMENT,
  stepRope,
  tipSpeed,
} from "./whipRope";

describe("whipRope", () => {
  it("hangs straight down and comes to rest under a still hand", () => {
    const rope = createRope(NODES, SEGMENT, 100, 100);
    for (let step = 0; step < 400; step += 1) stepRope(rope, { x: 100, y: 100 });

    const tip = NODES - 1;
    expect(rope.x[tip]).toBeCloseTo(100, 0);
    expect(rope.y[tip]).toBeGreaterThan(100 + (NODES - 1) * SEGMENT * 0.95);
    expect(tipSpeed(rope)).toBeLessThan(0.5);
  });

  it("never cracks from a slow drag", () => {
    const rope = createRope(NODES, SEGMENT, 100, 100);
    const snapped = createSnapDetector();
    let cracks = 0;
    for (let step = 0; step < 120; step += 1) {
      stepRope(rope, { x: 100 + step * 4, y: 100 });
      if (snapped(tipSpeed(rope), handSpeed(rope))) cracks += 1;
    }

    expect(cracks).toBe(0);
  });

  it("cracks once at the peak of a flick, not on every fast frame", () => {
    const rope = createRope(NODES, SEGMENT, 100, 100);
    for (let step = 0; step < 60; step += 1) stepRope(rope, { x: 100, y: 100 });
    const snapped = createSnapDetector();
    let fastFrames = 0;
    let cracks = 0;
    let x = 100;
    for (let step = 0; step < 8; step += 1) {
      x += 60;
      stepRope(rope, { x, y: 100 });
      if (tipSpeed(rope) > CRACK_TIP_SPEED) fastFrames += 1;
      if (snapped(tipSpeed(rope), handSpeed(rope))) cracks += 1;
    }
    for (let step = 0; step < 30; step += 1) {
      stepRope(rope, { x, y: 100 });
      if (tipSpeed(rope) > CRACK_TIP_SPEED) fastFrames += 1;
      if (snapped(tipSpeed(rope), handSpeed(rope))) cracks += 1;
    }

    expect(fastFrames).toBeGreaterThan(1);
    expect(cracks).toBe(1);
  });

  it("falls off the screen once let go", () => {
    const rope = createRope(NODES, SEGMENT, 100, 100);
    for (let step = 0; step < 60; step += 1) stepRope(rope, { x: 100, y: 100 });
    expect(ropeTop(rope)).toBeCloseTo(100, 0);

    for (let step = 0; step < 90; step += 1) stepRope(rope, null);

    expect(ropeTop(rope)).toBeGreaterThan(1000);
  });

  it("reports the peak only once the speed starts falling", () => {
    const snapped = createSnapDetector({ tipThreshold: 10, handThreshold: 1 });

    expect([5, 12, 20, 30, 25, 12, 5].map((speed) => snapped(speed, 5))).toEqual([
      false,
      false,
      false,
      false,
      true,
      false,
      false,
    ]);
  });

  it("ignores a fast tip when the hand did not flick", () => {
    const snapped = createSnapDetector({ tipThreshold: 10, handThreshold: 5 });

    expect([5, 12, 20, 30, 25, 12, 5].map((speed) => snapped(speed, 1))).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("forgets a flick after a while", () => {
    const snapped = createSnapDetector({ tipThreshold: 10, handThreshold: 5 });
    snapped(0, 40);
    for (let step = 0; step < 30; step += 1) snapped(0, 0);

    expect([12, 20, 30, 25].map((speed) => snapped(speed, 0))).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});
