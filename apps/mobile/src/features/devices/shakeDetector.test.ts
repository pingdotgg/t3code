import { describe, expect, it } from "vite-plus/test";

import { createShakeDetector } from "./shakeDetector";

const resting = (timestamp: number) => ({ x: 0, y: 0, z: -1, timestamp });
const jolt = (timestamp: number) => ({ x: 2.2, y: 0.4, z: -1, timestamp });

describe("shake detector", () => {
  it("ignores gravity and a single bump", () => {
    const detect = createShakeDetector();
    expect(detect(resting(0))).toBe(false);
    expect(detect(jolt(100))).toBe(false);
    expect(detect(resting(200))).toBe(false);
    expect(detect(jolt(900))).toBe(false);
  });

  it("reports two jolts within the window once, then cools down", () => {
    const detect = createShakeDetector();
    expect(detect(jolt(0))).toBe(false);
    expect(detect(jolt(300))).toBe(true);
    expect(detect(jolt(400))).toBe(false);
    expect(detect(jolt(600))).toBe(false);
    expect(detect(jolt(1_400))).toBe(false);
    expect(detect(jolt(1_500))).toBe(true);
  });
});
