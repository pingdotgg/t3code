import { describe, expect, it } from "vite-plus/test";

import { computeLabelPosition } from "./PickLabelPosition.ts";

const VIEWPORT = { viewportWidth: 1280, viewportHeight: 800 };

describe("computeLabelPosition", () => {
  it("anchors to the element's top-left when there's room above and to the right", () => {
    const { x, y } = computeLabelPosition({
      ...VIEWPORT,
      targetLeft: 200,
      targetTop: 200,
      targetBottom: 240,
      labelWidth: 120,
      labelHeight: 18,
    });
    expect(x).toBe(200);
    // 200 (top) - 18 (height) - 4 (gap)
    expect(y).toBe(200 - 18 - 4);
  });

  it("clamps left edge so the label stays inside the viewport", () => {
    const { x } = computeLabelPosition({
      ...VIEWPORT,
      targetLeft: -50,
      targetTop: 200,
      targetBottom: 240,
      labelWidth: 120,
      labelHeight: 18,
    });
    expect(x).toBe(4);
  });

  it("clamps right edge when the label would overflow the viewport (the bug we shipped)", () => {
    const { x } = computeLabelPosition({
      ...VIEWPORT,
      targetLeft: 1240,
      targetTop: 200,
      targetBottom: 240,
      labelWidth: 200,
      labelHeight: 18,
    });
    // viewportWidth (1280) - labelWidth (200) - margin (4) = 1076
    expect(x).toBe(1076);
  });

  it("flips the label below the element when there's no room above", () => {
    const { y } = computeLabelPosition({
      ...VIEWPORT,
      targetLeft: 200,
      targetTop: 4,
      targetBottom: 44,
      labelWidth: 120,
      labelHeight: 18,
    });
    // labelY = 4 - 18 - 4 = -18 → flip → 44 + 4 = 48
    expect(y).toBe(48);
  });

  it("pins to the bottom margin when the element fills the viewport (no room above OR below)", () => {
    const { y } = computeLabelPosition({
      ...VIEWPORT,
      targetLeft: 200,
      targetTop: 0,
      targetBottom: 800,
      labelWidth: 120,
      labelHeight: 18,
    });
    // Above overflows top → flip below = 800 + 4 = 804 → also overflows
    // bottom → pin to viewportHeight - labelHeight - margin = 778.
    expect(y).toBe(800 - 18 - 4);
  });

  it("never returns a negative coordinate", () => {
    const { x, y } = computeLabelPosition({
      ...VIEWPORT,
      targetLeft: -1000,
      targetTop: -1000,
      targetBottom: -900,
      labelWidth: 5000,
      labelHeight: 5000,
    });
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
  });
});
