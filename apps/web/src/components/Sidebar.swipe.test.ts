import { describe, expect, it } from "vite-plus/test";

import { resolveSwipeRelease, resolveThreadSwipeActions } from "./Sidebar.swipe";

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
    // actionsWidth + 48 would be 192, but 55% of 260 is 143, so the max is 192.
    expect(resolveSwipeRelease({ offset: -150, actionsWidth, contentWidth: 260 })).toBe("open");
    expect(resolveSwipeRelease({ offset: -192, actionsWidth, contentWidth: 260 })).toBe("commit");
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
