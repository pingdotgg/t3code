import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });

  it("lists move targets as a submenu, and hides it when there are none", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      moveTargets: [
        { id: "p1", title: "Web Tweaks" },
        { id: "p2", title: "TripLedger" },
      ],
    });
    const move = items.find((item) => item.id === "move-to-project");
    expect(move?.label).toBe("Move to project");
    expect(move?.disabled).toBe(false);
    expect(move?.children?.map((child) => [child.id, child.label])).toEqual([
      ["move-to-project:p1", "Web Tweaks"],
      ["move-to-project:p2", "TripLedger"],
    ]);
    expect(
      buildThreadActionMenuItems({ ...baseState, moveTargets: [] }).some(
        (item) => item.id === "move-to-project",
      ),
    ).toBe(false);
    expect(
      buildThreadActionMenuItems({
        ...baseState,
        isRunning: true,
        moveTargets: [{ id: "p1", title: "Web Tweaks" }],
      }).find((item) => item.id === "move-to-project")?.disabled,
    ).toBe(true);
  });
});
