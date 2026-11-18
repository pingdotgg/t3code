import { describe, expect, it } from "vite-plus/test";

import {
  buildDraftActionMenuItems,
  buildThreadActionMenuItems,
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
});

describe("buildDraftActionMenuItems", () => {
  const draftMenu = (isSnoozed: boolean) =>
    buildDraftActionMenuItems({
      hasPath: true,
      hasBranch: false,
      hasProject: true,
      isSnoozed,
      canSnoozeNow: true,
      snoozePresets: baseState.snoozePresets,
    });

  it("offers Snooze with the presets and Custom, and Wake once snoozed", () => {
    expect(draftMenu(false)[0]).toMatchObject({
      id: "snooze",
      children: [{ id: "snooze:hour", detail: "3:00 PM" }, { id: "snooze:custom" }],
    });
    expect(draftMenu(true)[0]).toMatchObject({ id: "unsnooze", label: "Wake draft" });
    expect(draftMenu(true).some((item) => item.id === "snooze")).toBe(false);
  });
});
