import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
  moveProjectMenuState,
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

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });

  it("disables only rename where no inline title editor exists", () => {
    const items = buildThreadActionMenuItems({ ...baseState, canRename: false });
    expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(["rename"]);
  });

  it("offers other projects, and only an idle top-level thread can move", () => {
    const thread = {
      environmentId: "env",
      projectId: "a",
      lineage: { relationshipToParent: null },
    };
    const projects = [
      { environmentId: "env", id: "a", title: "A" },
      { environmentId: "env", id: "b", title: "B" },
      { environmentId: "env", id: "c", title: "C", archivedAt: "2026-01-01T00:00:00Z" },
      { environmentId: "other", id: "d", title: "D" },
      { environmentId: "env", id: "s", title: "scratch", isScratch: true as const },
    ];
    const state = moveProjectMenuState(thread, projects);
    expect(state.moveProjectTargets.map((target) => target.id)).toEqual(["b", "s"]);
    expect(state.canMoveProject).toBe(true);
    expect(
      moveProjectMenuState({ ...thread, lineage: { relationshipToParent: "subagent" } }, projects)
        .canMoveProject,
    ).toBe(false);
    const move = buildThreadActionMenuItems({ ...baseState, ...state, isRunning: true }).find(
      (item) => item.id === "move-project",
    );
    expect(move?.disabled).toBe(true);
    expect(move?.children?.map((child) => child.id)).toEqual(["move-project:b", "move-project:s"]);
  });
});
