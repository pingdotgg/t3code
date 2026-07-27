import { assert, describe, it } from "vite-plus/test";

import {
  DEFAULT_TRANSLUCENCY,
  PLATE_START,
  TRANSLUCENCY_RANGE,
  backdropForTranslucency,
  chatWashBase,
  clampTranslucency,
  coverage,
  layerStack,
  photoOpacity,
  washAlpha,
  windowPlate,
} from "./glass.ts";

const SCHEMES = ["dark", "light"] as const;

describe("glass layering", () => {
  // The whole point of the model: what the app paints behind chat content
  // covers exactly the requested translucency, so `1 - t` of the desktop
  // reaches the user. Mirrors `GlassLayeringTests.coverageMatchesTranslucency`
  // — the macOS UIProbe measures 0.502 / 0.651 / 0.847 / 1.000 on the real
  // window for these stops.
  it("photo + wash cover exactly the requested translucency", () => {
    for (const t of [0.5, 0.65, 0.75, 0.85, 1]) {
      for (const scheme of SCHEMES) {
        const wash = washAlpha(chatWashBase(scheme), t);
        const photo = photoOpacity(t, wash);
        assert.closeTo(coverage(photo, wash), t, 0.0001);
      }
    }
  });

  it("carries the scene at full opacity only when the window is solid", () => {
    const dark = chatWashBase("dark");
    assert.equal(photoOpacity(1, washAlpha(dark, 1)), 1);

    // At the glass end the image is still clearly present, just not a plate.
    const glassPhoto = photoOpacity(0.5, washAlpha(dark, 0.5));
    assert.isAbove(glassPhoto, 0.25);
    assert.isBelow(glassPhoto, 0.45);
  });

  it("fades wash and photo together as the window turns to glass", () => {
    const stops = [1, 0.9, 0.8, 0.7, 0.6, 0.5];
    const washes = stops.map((t) => washAlpha(chatWashBase("dark"), t));
    const photos = stops.map((t, index) => photoOpacity(t, washes[index]!));

    for (let index = 1; index < stops.length; index += 1) {
      assert.isBelow(washes[index]!, washes[index - 1]!);
      assert.isBelow(photos[index]!, photos[index - 1]!);
    }
  });

  it("clamps out-of-range translucency instead of over/under-covering", () => {
    assert.equal(washAlpha(0.5, -1), washAlpha(0.5, TRANSLUCENCY_RANGE.lowerBound));
    assert.equal(photoOpacity(2, 0), 1);
    assert.equal(photoOpacity(0.8, 1), 0);
    assert.equal(clampTranslucency(0), TRANSLUCENCY_RANGE.lowerBound);
    assert.equal(clampTranslucency(5), TRANSLUCENCY_RANGE.upperBound);
  });

  // Not a macOS behaviour — Swift's `min`/`max` propagate NaN, and a NaN
  // translucency there would poison every downstream alpha. A persisted
  // settings file with a corrupt number must degrade to the default here.
  it("treats a NaN translucency as the default rather than poisoning the stack", () => {
    assert.equal(clampTranslucency(Number.NaN), DEFAULT_TRANSLUCENCY);
    assert.isFalse(Number.isNaN(layerStack(Number.NaN, "dark").coverage));
  });

  it("keeps the window plate at zero through the glass band and solid at 1.0", () => {
    assert.equal(windowPlate(0.5), 0);
    assert.equal(windowPlate(0.75), 0);
    assert.equal(windowPlate(PLATE_START), 0);
    assert.equal(windowPlate(1), 1);

    const mid = windowPlate(0.925);
    assert.isAbove(mid, 0.4);
    assert.isBelow(mid, 0.6);
  });

  it("starts the plate ramp at the default translucency", () => {
    assert.equal(PLATE_START, DEFAULT_TRANSLUCENCY);
  });

  it("drops the DWM material once the window is fully solid", () => {
    // Asking DWM for Mica behind an opaque window is wasted compositing, and
    // it bleeds through the Windows 11 rounded corners.
    assert.equal(backdropForTranslucency(1, "mica-alt"), "none");
    assert.equal(backdropForTranslucency(0.85, "mica-alt"), "mica-alt");
    assert.equal(backdropForTranslucency(0.5, "acrylic"), "acrylic");
  });

  it("exposes a stack whose coverage matches the slider", () => {
    for (const t of [0.5, 0.7, 0.85, 1]) {
      const stack = layerStack(t, "dark");
      assert.closeTo(stack.coverage, t, 0.0001);
      assert.isAtLeast(stack.plateAlpha, 0);
      assert.isAtMost(stack.plateAlpha, 1);
    }
  });
});
