import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
  threadActionRequiresOperate,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

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

  it.each([false, true])(
    "allows read-only project filtering without enabling mutations (active: %s)",
    (isActive) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        projectFilter: { label: "Example project", isActive },
      });
      expect(items.find((item) => item.id === "filter-by-project")).toMatchObject({
        label: isActive ? "Show all projects" : "Filter by Example project",
      });
      expect(items.find((item) => item.id === "filter-by-project")?.disabled).not.toBe(true);
      expect(threadActionRequiresOperate("filter-by-project")).toBe(false);
      for (const action of ["rename", "archive", "delete"] as const) {
        expect(items.find((item) => item.id === action)?.disabled).toBe(true);
        expect(threadActionRequiresOperate(action)).toBe(true);
      }
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
});
