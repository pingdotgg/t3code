import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
  buildThreadMoveTargets,
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
  canMoveProject: true,
  moveTargets: [],
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

  it("disables archive while the thread is running", () => {
    const archiveItem = buildThreadActionMenuItems({ ...baseState, isRunning: true }).find(
      (item) => item.id === "archive",
    );
    expect(archiveItem?.disabled).toBe(true);
  });

  it("lists other projects and hides the picker while a move is refused", () => {
    const moveTargets = [{ projectId: "project-b" as ProjectId, label: "Beta" }];
    const open = buildThreadActionMenuItems({ ...baseState, moveTargets }).find(
      (item) => item.id === "move-project",
    );
    expect(open?.children?.map((child) => child.label)).toEqual(["Beta"]);
    const blocked = buildThreadActionMenuItems({
      ...baseState,
      moveTargets,
      canMoveProject: false,
    }).find((item) => item.id === "move-project");
    expect(blocked?.disabled).toBe(true);
    expect(blocked?.children).toBeUndefined();
  });
});

describe("buildThreadMoveTargets", () => {
  it("offers projects in the same environment except the current one", () => {
    const environment = (id: string) => id as EnvironmentId;
    const project = (id: string) => id as ProjectId;
    const targets = buildThreadMoveTargets(
      [
        { environmentId: environment("env-1"), id: project("current"), title: "Here" },
        { environmentId: environment("env-1"), id: project("other"), title: "Elsewhere" },
        {
          environmentId: environment("env-1"),
          id: project("scratch"),
          title: "scratch",
          isScratch: true,
        },
        { environmentId: environment("env-2"), id: project("remote"), title: "Other environment" },
      ],
      { environmentId: environment("env-1"), projectId: project("current") },
    );
    expect(targets.map((target) => target.label)).toEqual(["Elsewhere", "No project"]);
  });
});
