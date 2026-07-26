import { assert, describe, it } from "vite-plus/test";

import {
  ambient,
  burst,
  curveCss,
  delight,
  feedback,
  motionCssVariables,
  motionProfile,
  reveal,
  scenery,
  structure,
  transition,
} from "./motion.ts";

const FULL = motionProfile(false);
const REDUCED = motionProfile(true);

describe("motion profile", () => {
  it("keeps the macOS durations", () => {
    assert.equal(FULL.feedbackDuration, 0.14);
    assert.equal(FULL.revealDuration, 0.19);
    assert.equal(FULL.structureDuration, 0.24);
    assert.equal(FULL.delightDuration, 0.4);
    assert.equal(FULL.burstDuration, 0.6);
  });

  it("collapses the change duration under reduce motion", () => {
    assert.equal(FULL.changeDuration, FULL.revealDuration);
    assert.equal(REDUCED.changeDuration, 0.12);
  });

  it("gates movement and decoration on the accessibility preference", () => {
    assert.isTrue(FULL.usesMovement);
    assert.isTrue(FULL.allowsDecorativeEffects);
    assert.isFalse(REDUCED.usesMovement);
    assert.isFalse(REDUCED.allowsDecorativeEffects);
  });
});

describe("curves", () => {
  it("routes every movement-bearing curve through the quick fade when reduced", () => {
    // The guarantee: nothing slides, scales, springs or pulses, but state
    // changes still ease rather than popping.
    for (const curve of [feedback, reveal, structure, delight]) {
      const reducedCurve = curve(REDUCED);
      assert.equal(reducedCurve.duration, REDUCED.changeDuration);
      assert.equal(reducedCurve.easing, "ease-out");
    }
  });

  it("keeps distinct curves when motion is allowed", () => {
    const easings = new Set(
      [feedback, reveal, structure, delight, ambient].map((curve) => curve(FULL).easing),
    );
    // feedback and reveal deliberately share the signature ease-out; the rest
    // must not collapse onto one another.
    assert.isAtLeast(easings.size, 4);
    assert.equal(feedback(FULL).easing, reveal(FULL).easing);
  });

  it("never lets a reduced curve run longer than the full one", () => {
    for (const curve of [feedback, reveal, structure, delight, burst, ambient, scenery]) {
      assert.isAtMost(curve(REDUCED).duration, curve(FULL).duration);
    }
  });

  it("emits CSS shorthand", () => {
    assert.equal(curveCss(reveal(FULL)), "0.19s cubic-bezier(0.23, 1, 0.32, 1)");
    assert.equal(curveCss(ambient(REDUCED)), "0.12s cubic-bezier(0.77, 0, 0.175, 1)");
  });
});

describe("transitions", () => {
  it("collapses every transition to a plain fade under reduce motion", () => {
    for (const name of ["rise", "materialize", "pop", "banner", "unfold", "pane-change"] as const) {
      assert.equal(transition(name, REDUCED), "opacity");
      assert.equal(transition(name, FULL), name);
    }
  });
});

describe("css variables", () => {
  it("publishes every curve plus the decorative gate", () => {
    const variables = motionCssVariables(FULL);
    assert.hasAllKeys(variables, [
      "--motion-feedback",
      "--motion-reveal",
      "--motion-structure",
      "--motion-delight",
      "--motion-burst",
      "--motion-ambient",
      "--motion-scenery",
      "--motion-decorative-opacity",
    ]);
    assert.equal(variables["--motion-decorative-opacity"], "1");
    assert.equal(motionCssVariables(REDUCED)["--motion-decorative-opacity"], "0");
  });
});
