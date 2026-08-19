import { describe, expect, it } from "vite-plus/test";

import { animatedNumberAt, easeOutCubic } from "./useAnimatedNumber";

describe("easeOutCubic", () => {
  it("is clamped and monotonic across the tween", () => {
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(2)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });
});

describe("animatedNumberAt", () => {
  it("lands exactly on the target at and past the duration", () => {
    expect(animatedNumberAt(0, 0.8, 400, 400)).toBe(0.8);
    expect(animatedNumberAt(0, 0.8, 900, 400)).toBe(0.8);
    expect(animatedNumberAt(0.2, 0.9, 0, 0)).toBe(0.9);
  });

  it("stays between the endpoints while running, in both directions", () => {
    const rising = animatedNumberAt(0.2, 0.8, 200, 400);
    expect(rising).toBeGreaterThan(0.2);
    expect(rising).toBeLessThan(0.8);

    const falling = animatedNumberAt(0.8, 0.2, 200, 400);
    expect(falling).toBeLessThan(0.8);
    expect(falling).toBeGreaterThan(0.2);
  });
});
