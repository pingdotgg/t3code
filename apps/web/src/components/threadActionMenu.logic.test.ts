import { TeamViewId } from "@t3tools/contracts";
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
  hasCompletedRun: true,
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

  it.each([
    ["while the thread is running", { isRunning: true }],
    ["before any run has completed", { hasCompletedRun: false }],
  ])("omits mark unread %s", (_, overrides) => {
    const items = buildThreadActionMenuItems({ ...baseState, ...overrides });
    expect(items.map((item) => item.id)).not.toContain("mark-unread");
  });

  it("disables only rename where no inline title editor exists", () => {
    const items = buildThreadActionMenuItems({ ...baseState, canRename: false });
    expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(["rename"]);
  });

  it("includes follow/unfollow for colleagues' team threads and keeps them available to read-only viewers", () => {
    const ownItems = buildThreadActionMenuItems({ ...baseState, teamFollow: null });
    expect(ownItems.map((item) => item.id)).not.toContain("follow");
    expect(ownItems.map((item) => item.id)).not.toContain("unfollow");

    const unfollowed = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
      teamFollow: { isFollowing: false },
    });
    const followItem = unfollowed.find((item) => item.id === "follow");
    expect(followItem).toMatchObject({ id: "follow", icon: "bell" });
    expect(followItem?.disabled).not.toBe(true);

    const followed = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
      teamFollow: { isFollowing: true },
    });
    const unfollowItem = followed.find((item) => item.id === "unfollow");
    expect(unfollowItem).toMatchObject({ id: "unfollow", icon: "bell-off" });
    expect(unfollowItem?.disabled).not.toBe(true);
  });

  it("includes team view submenu and lock/unlock controls when permitted", () => {
    const defaultViewId = TeamViewId.make("view-default");
    const staffViewId = TeamViewId.make("view-staff");
    const items = buildThreadActionMenuItems({
      ...baseState,
      teamView: {
        currentViewId: defaultViewId,
        views: [
          { id: defaultViewId, name: "Default" },
          { id: staffViewId, name: "Staff Only" },
        ],
      },
      teamLock: { isLocked: false },
    });

    const viewMenu = items.find((item) => item.id === "team-view");
    expect(viewMenu?.children).toEqual([
      { id: `team-view:${defaultViewId}`, label: "Default", checked: true },
      { id: `team-view:${staffViewId}`, label: "Staff Only", checked: false },
    ]);
    expect(items.find((item) => item.id === "team-lock")).toMatchObject({
      id: "team-lock",
      icon: "lock",
    });

    const lockedItems = buildThreadActionMenuItems({
      ...baseState,
      teamLock: { isLocked: true },
    });
    expect(lockedItems.find((item) => item.id === "team-unlock")).toMatchObject({
      id: "team-unlock",
      icon: "unlock",
    });
  });
});
