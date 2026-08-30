import { describe, expect, it } from "vite-plus/test";

import { normalizeVoiceInputDecibels } from "./voiceInputMetering";

describe("normalizeVoiceInputDecibels", () => {
  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "treats a missing or invalid reading %s as silence",
    (decibels) => {
      expect(normalizeVoiceInputDecibels(decibels)).toBe(0);
    },
  );

  it.each([-160, -90, -55])("keeps a reading at or below the noise floor %s silent", (decibels) => {
    expect(normalizeVoiceInputDecibels(decibels)).toBe(0);
  });

  it("keeps quiet background levels small and gives speech a clear increase", () => {
    const quiet = normalizeVoiceInputDecibels(-50);
    const speech = normalizeVoiceInputDecibels(-35);

    expect(quiet).toBeLessThan(0.06);
    expect(speech).toBeGreaterThan(0.6);
    expect(speech - quiet).toBeGreaterThan(0.5);
    expect(normalizeVoiceInputDecibels(-30)).toBeGreaterThan(0.8);
  });

  it("preserves increasing loudness across the speech range", () => {
    const levels = [-55, -50, -45, -40, -35, -30, -25, -20].map(normalizeVoiceInputDecibels);
    expect(levels.every((level, index) => index === 0 || level > levels[index - 1]!)).toBe(true);
  });

  it("approaches silence and maximum height without a jump", () => {
    expect(normalizeVoiceInputDecibels(-54.99)).toBeLessThan(0.000001);
    expect(normalizeVoiceInputDecibels(-20.01)).toBeGreaterThan(0.999999);
  });

  it.each([-20, -10, 0, 6, 160])("caps loud readings %s at one", (decibels) => {
    expect(normalizeVoiceInputDecibels(decibels)).toBe(1);
  });
});
