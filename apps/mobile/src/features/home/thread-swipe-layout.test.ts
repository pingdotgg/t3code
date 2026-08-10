import { describe, expect, it } from "vite-plus/test";

import { ACTION_ITEM_WIDTH, swipeActionEntryRange, swipeActionsWidth } from "./thread-swipe-layout";

describe("swipeActionsWidth", () => {
  it("gives one slot per action", () => {
    expect(swipeActionsWidth(1)).toBe(ACTION_ITEM_WIDTH);
    expect(swipeActionsWidth(2)).toBe(ACTION_ITEM_WIDTH * 2);
    expect(swipeActionsWidth(3)).toBe(ACTION_ITEM_WIDTH * 3);
  });

  it("never collapses to zero width", () => {
    expect(swipeActionsWidth(0)).toBe(ACTION_ITEM_WIDTH);
  });
});

describe("swipeActionEntryRange", () => {
  // The tray used to hardcode one range per slot. Widening it to three actions
  // must not move the lists that still pass one or two, so these assert the
  // exact numbers the two-slot tray shipped with.
  it("reproduces the outermost slot's original range", () => {
    expect(swipeActionEntryRange(0)).toEqual([8, ACTION_ITEM_WIDTH * 0.72]);
  });

  it("reproduces the second slot's original range", () => {
    expect(swipeActionEntryRange(1)).toEqual([
      ACTION_ITEM_WIDTH * 0.55,
      ACTION_ITEM_WIDTH * 2 * 0.85,
    ]);
  });

  it("keeps entering later the further a slot sits from the edge", () => {
    const [firstStart] = swipeActionEntryRange(0);
    const [secondStart] = swipeActionEntryRange(1);
    const [thirdStart] = swipeActionEntryRange(2);
    expect(firstStart).toBeLessThan(secondStart);
    expect(secondStart).toBeLessThan(thirdStart);
  });

  it("opens each slot before the swipe has revealed the whole tray", () => {
    // A slot that only finished entering past its own tray width would still
    // be animating when the row is fully open.
    for (const slot of [0, 1, 2]) {
      const [start] = swipeActionEntryRange(slot);
      expect(start).toBeLessThan(swipeActionsWidth(slot + 1));
    }
  });
});
