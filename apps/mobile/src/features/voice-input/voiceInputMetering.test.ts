import { describe, expect, it } from "vite-plus/test";

import { normalizeVoiceInputDecibels } from "./voiceInputMetering";

describe("normalizeVoiceInputDecibels", () => {
  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "treats a missing or invalid reading %s as silence",
    (decibels) => {
      expect(normalizeVoiceInputDecibels(decibels)).toBe(0);
    },
  );

  it.each([-160, -90, -60])("keeps a reading at or below the noise floor %s silent", (decibels) => {
    expect(normalizeVoiceInputDecibels(decibels)).toBe(0);
  });

  it("keeps quiet background readings close to the baseline", () => {
    const quiet = normalizeVoiceInputDecibels(-50);
    expect(quiet).toBeGreaterThan(0);
    expect(quiet).toBeLessThan(0.05);
  });

  it("keeps loud negative speech readings distinct below full height", () => {
    const levels = [-20, -18, -12, -6, -3].map(normalizeVoiceInputDecibels);

    for (const level of levels) {
      expect(level).toBeGreaterThan(0);
      expect(level).toBeLessThan(1);
    }
    expect(levels.every((level, index) => index === 0 || level > levels[index - 1]!)).toBe(true);
  });

  it("makes near-speech changes visible without an early ceiling", () => {
    expect(normalizeVoiceInputDecibels(-6) - normalizeVoiceInputDecibels(-12)).toBeGreaterThan(
      0.18,
    );
    expect(normalizeVoiceInputDecibels(-3) - normalizeVoiceInputDecibels(-12)).toBeGreaterThan(0.3);
  });

  it("increases throughout the usable microphone range", () => {
    const levels = [-60, -55, -50, -40, -30, -20, -12, -6, -3, -0.001, 0].map(
      normalizeVoiceInputDecibels,
    );
    expect(levels.every((level, index) => index === 0 || level > levels[index - 1]!)).toBe(true);
  });

  it("approaches the noise floor and full scale without a jump", () => {
    expect(normalizeVoiceInputDecibels(-59.999)).toBeLessThan(0.001);
    expect(normalizeVoiceInputDecibels(-0.001)).toBeGreaterThan(0.999);
    expect(normalizeVoiceInputDecibels(-0.001)).toBeLessThan(1);
  });

  it.each([0, 6, 160])("caps only full-scale or higher readings %s at one", (decibels) => {
    expect(normalizeVoiceInputDecibels(decibels)).toBe(1);
  });
});
