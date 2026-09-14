import { describe, expect, it } from "vite-plus/test";

import {
  resolveSwipeRelease,
  resolveThreadSwipeActions,
  updateSwipeGesture,
  type SwipeGestureState,
} from "./Sidebar.swipe";

describe("resolveThreadSwipeActions", () => {
  it("cards settle, settled rows un-settle, snoozed rows wake", () => {
    expect(
      resolveThreadSwipeActions({
        variantAction: "settle",
        settlementSupported: true,
        snoozeSupported: true,
        canSnoozeNow: true,
        pinningSupported: true,
        isPinned: false,
      }).primary,
    ).toBe("settle");
    expect(
      resolveThreadSwipeActions({
        variantAction: "unsettle",
        settlementSupported: true,
        snoozeSupported: true,
        canSnoozeNow: true,
        pinningSupported: true,
        isPinned: false,
      }).primary,
    ).toBe("unsettle");
    expect(
      resolveThreadSwipeActions({
        variantAction: "unsnooze",
        settlementSupported: true,
        snoozeSupported: true,
        canSnoozeNow: true,
        pinningSupported: true,
        isPinned: false,
      }).primary,
    ).toBe("unsnooze");
  });

  it("drops the lifecycle action where the server lacks settlement", () => {
    const actions = resolveThreadSwipeActions({
      variantAction: "settle",
      settlementSupported: false,
      snoozeSupported: true,
      canSnoozeNow: true,
      pinningSupported: true,
      isPinned: false,
    });
    expect(actions.primary).toBeNull();
    // Snooze is independent of settlement.
    expect(actions.snooze).toBe(true);
  });

  it("drops wake on snoozed rows where the server lacks snooze", () => {
    const actions = resolveThreadSwipeActions({
      variantAction: "unsnooze",
      settlementSupported: true,
      snoozeSupported: false,
      canSnoozeNow: false,
      pinningSupported: true,
      isPinned: false,
    });
    expect(actions.primary).toBeNull();
  });

  it("offers snooze beside the primary only when it can succeed right now", () => {
    const base = {
      variantAction: "settle" as const,
      settlementSupported: true,
      snoozeSupported: true,
      pinningSupported: true,
      isPinned: false,
    };
    expect(resolveThreadSwipeActions({ ...base, canSnoozeNow: true }).snooze).toBe(true);
    expect(resolveThreadSwipeActions({ ...base, canSnoozeNow: false }).snooze).toBe(false);
    expect(
      resolveThreadSwipeActions({ ...base, canSnoozeNow: true, snoozeSupported: false }).snooze,
    ).toBe(false);
    // Snoozed rows already wake via the primary; no snooze beside it.
    expect(
      resolveThreadSwipeActions({
        ...base,
        variantAction: "unsnooze",
        canSnoozeNow: true,
      }).snooze,
    ).toBe(false);
  });

  it("toggles the pin in the opposite direction only where pinning is supported", () => {
    const base = {
      variantAction: "settle" as const,
      settlementSupported: true,
      snoozeSupported: true,
      canSnoozeNow: true,
      pinningSupported: true,
    };
    expect(resolveThreadSwipeActions({ ...base, isPinned: false }).pin).toBe("pin");
    expect(resolveThreadSwipeActions({ ...base, isPinned: true }).pin).toBe("unpin");
    expect(
      resolveThreadSwipeActions({ ...base, isPinned: true, pinningSupported: false }).pin,
    ).toBeNull();
  });
});

describe("resolveSwipeRelease", () => {
  const actionsWidth = 144;
  const contentWidth = 260;

  it("commits a full swipe past the actions", () => {
    expect(
      resolveSwipeRelease({
        offset: -(actionsWidth + 48),
        actionsWidth,
        contentWidth,
      }),
    ).toBe("commit");
  });

  it("commits on a short row where the 55% width bound is the binding threshold", () => {
    // With one 72px action the action bound is 120, but 55% of 260 is 143, so
    // the width bound is what the drag has to beat.
    expect(resolveSwipeRelease({ offset: -130, actionsWidth: 72, contentWidth: 260 })).toBe("open");
    expect(resolveSwipeRelease({ offset: -143, actionsWidth: 72, contentWidth: 260 })).toBe(
      "commit",
    );
  });

  it("opens a drag past the snap threshold", () => {
    expect(resolveSwipeRelease({ offset: -40, actionsWidth, contentWidth })).toBe("open");
    expect(resolveSwipeRelease({ offset: 40, actionsWidth, contentWidth })).toBe("open");
  });

  it("springs back from a short drag", () => {
    expect(resolveSwipeRelease({ offset: -20, actionsWidth, contentWidth })).toBe("close");
    expect(resolveSwipeRelease({ offset: 20, actionsWidth, contentWidth })).toBe("close");
  });

  it("never opens or commits rows without actions", () => {
    expect(resolveSwipeRelease({ offset: -500, actionsWidth: 0, contentWidth })).toBe("close");
  });
});

describe("updateSwipeGesture", () => {
  const widths = { start: 72, end: 144 };
  const contentWidth = 260;

  it("flips direction when a decided drag crosses back over the origin", () => {
    let gesture: Omit<SwipeGestureState, "pointerId"> = {
      startX: 200,
      startY: 100,
      offset: 0,
      decided: false,
      direction: "end",
    };
    const move = (dx: number, dy = 0) => {
      const result = updateSwipeGesture(gesture, dx, dy, widths, contentWidth);
      if (result._tag === "cancel") return "cancel";
      gesture = { ...gesture, ...result.state };
      return gesture;
    };
    // Decide leftward, then drag back across the origin and past the commit
    // threshold on the right: the release must belong to the start action.
    move(-30);
    const final = move(160);
    if (final === "cancel") throw new Error("expected move");
    expect(final.decided).toBe(true);
    expect(final.direction).toBe("start");
    expect(final.offset).toBeGreaterThanOrEqual(143);
  });

  it("caps the drag so a one-action row can still reach its commit threshold", () => {
    const result = updateSwipeGesture(
      { startX: 0, startY: 0, offset: 0, decided: true, direction: "end" },
      -500,
      0,
      { start: 0, end: 72 },
      260,
    );
    if (result._tag !== "move") throw new Error("expected move");
    // Commit threshold for one action on a 260px row is max(120, 143) = 143.
    expect(result.state.offset).toBeLessThanOrEqual(-143);
  });

  it("cancels a vertically dominant undecided drag", () => {
    const result = updateSwipeGesture(
      { startX: 0, startY: 0, offset: 0, decided: false, direction: "end" },
      2,
      20,
      widths,
      contentWidth,
    );
    expect(result._tag).toBe("cancel");
  });

  it("leaves an undecided micro-drag untouched", () => {
    const result = updateSwipeGesture(
      { startX: 0, startY: 0, offset: 0, decided: false, direction: "end" },
      3,
      0,
      widths,
      contentWidth,
    );
    if (result._tag !== "move") throw new Error("expected move");
    expect(result.state.decided).toBe(false);
    expect(result.state.offset).toBe(0);
  });
});
