import { describe, expect, it } from "vite-plus/test";

import { deriveMenuHorizontalPlacement } from "./menu-placement";

const base = { anchorWidth: 48, overlayWidth: 852, desiredWidth: 224, margin: 12 };

describe("deriveMenuHorizontalPlacement", () => {
  it("opens toward the roomier side of the whole screen without a hinge", () => {
    expect(deriveMenuHorizontalPlacement({ ...base, anchorX: 300, hinge: null })).toEqual({
      left: 300,
      width: 224,
    });
  });

  it("keeps a menu on its anchor's side of a creased hinge", () => {
    // The filter button sits near the crease, so the menu right-aligns to it instead of crossing.
    expect(
      deriveMenuHorizontalPlacement({ ...base, anchorX: 340, hinge: { x: 426, width: 0 } }),
    ).toEqual({ left: 164, width: 224 });
    expect(
      deriveMenuHorizontalPlacement({ ...base, anchorX: 430, hinge: { x: 426, width: 0 } }),
    ).toEqual({ left: 438, width: 224 });
  });
});
