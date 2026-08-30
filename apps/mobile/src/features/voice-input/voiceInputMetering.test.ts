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

  it("preserves changes in recorded power above the noise floor", () => {
    expect(normalizeVoiceInputDecibels(-45)).toBeCloseTo(0.25);
    expect(normalizeVoiceInputDecibels(-30)).toBeCloseTo(0.5);
    expect(normalizeVoiceInputDecibels(-15)).toBeCloseTo(0.75);
  });

  it.each([0, 6, 160])("caps full-scale or louder readings %s at one", (decibels) => {
    expect(normalizeVoiceInputDecibels(decibels)).toBe(1);
  });
});
