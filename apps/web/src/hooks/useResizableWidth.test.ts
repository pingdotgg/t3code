import { describe, expect, it } from "vite-plus/test";

import { nextWidthForKey } from "./useResizableWidth";

const BOUNDS = { minWidth: 220, maxWidth: 520 } as const;

function press(
  key: string,
  edge: "left" | "right",
  extra: { width?: number; shiftKey?: boolean } = {},
) {
  return nextWidthForKey({
    key,
    shiftKey: extra.shiftKey ?? false,
    width: extra.width ?? 300,
    edge,
    ...BOUNDS,
  });
}

describe("nextWidthForKey", () => {
  it("moves the handle left on ArrowLeft — whichever edge it sits on", () => {
    // Right-anchored panel: handle on its left edge, so left = wider.
    expect(press("ArrowLeft", "left")).toBe(308);
    // Left-anchored panel: handle on its right edge, so left = narrower.
    expect(press("ArrowLeft", "right")).toBe(292);
  });

  it("moves the handle right on ArrowRight", () => {
    expect(press("ArrowRight", "left")).toBe(292);
    expect(press("ArrowRight", "right")).toBe(308);
  });

  it("takes a coarse step with Shift", () => {
    expect(press("ArrowLeft", "left", { shiftKey: true })).toBe(348);
  });

  it("parks the handle at either extreme with Home and End", () => {
    // Home = handle all the way left, which for a right-anchored panel is
    // its widest — not its smallest number.
    expect(press("Home", "left")).toBe(520);
    expect(press("End", "left")).toBe(220);
    expect(press("Home", "right")).toBe(220);
    expect(press("End", "right")).toBe(520);
  });

  it("leaves keys it does not own alone", () => {
    expect(press("ArrowUp", "left")).toBeNull();
    expect(press("Enter", "left")).toBeNull();
    expect(press("a", "left")).toBeNull();
  });

  it("may step past the bounds — the caller clamps", () => {
    // Deliberate: this function answers "where does the key point", the hook
    // owns the allowed range. Splitting it the other way would duplicate the
    // clamp that already guards the stored and dragged width.
    expect(press("ArrowLeft", "left", { width: 518 })).toBe(526);
  });
});
