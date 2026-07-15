import { describe, expect, it } from "@effect/vitest";
import {
  isComposerCommandPopoverPlacementReady,
  placeComposerCommandPopover,
} from "./composerCommandPopoverLayout";

describe("placeComposerCommandPopover", () => {
  const base = {
    anchor: { x: 16, y: 600, width: 358, height: 140 },
    menuWidth: 358,
    menuHeight: 180,
    windowWidth: 390,
    windowHeight: 844,
    topInset: 44,
    bottomInset: 34,
  };

  it("places the menu above the full multiline composer", () => {
    expect(placeComposerCommandPopover(base)).toEqual({ left: 16, top: 412, width: 358 });
  });

  it("clamps horizontally and flips below when the top edge has no room", () => {
    expect(
      placeComposerCommandPopover({
        ...base,
        anchor: { x: 100, y: 60, width: 358, height: 80 },
      }),
    ).toEqual({ left: 32, top: 148, width: 358 });
  });

  it("keeps the menu within horizontal safe-area insets in landscape", () => {
    expect(
      placeComposerCommandPopover({
        ...base,
        anchor: { ...base.anchor, x: 10 },
        menuWidth: 800,
        windowWidth: 844,
        leftInset: 44,
        rightInset: 44,
      }),
    ).toEqual({ left: 44, top: 412, width: 756 });
  });
});

describe("isComposerCommandPopoverPlacementReady", () => {
  it("keeps the surface hidden and inert before measurement", () => {
    expect(isComposerCommandPopoverPlacementReady(null)).toBe(false);
  });

  it("allows the measured surface to render", () => {
    expect(isComposerCommandPopoverPlacementReady({ left: 16, top: 412, width: 358 })).toBe(true);
  });
});
