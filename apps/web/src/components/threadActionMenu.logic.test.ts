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

  it("lists plugin actions as their own section before Copy", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      pluginActions: [
        { id: "plugin-action:a", label: "Open dashboard" },
        { id: "plugin-action:b", label: "Deploy" },
      ],
    });
    const first = items.findIndex((item) => item.id === "plugin-action:a");
    expect(items.slice(first, first + 3).map((item) => [item.id, item.separatorBefore])).toEqual([
      ["plugin-action:a", true],
      ["plugin-action:b", undefined],
      ["copy", true],
    ]);
    expect(buildThreadActionMenuItems(baseState).map((item) => item.id)).not.toContain(
      "plugin-action:a",
    );
    const denied = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
      pluginActions: [{ id: "plugin-action:a", label: "Open dashboard" }],
    });
    // Running a plugin action needs orchestration:operate, like the thread mutations.
    expect(denied.find((item) => item.id === "plugin-action:a")?.disabled).toBe(true);
  });

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });
});
