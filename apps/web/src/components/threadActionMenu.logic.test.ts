import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
  transcriptViewFromMenuAction,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  transcriptView: "normal",
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
  it("offers every Transcript view level with the current one checked, even to read-only clients", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
      transcriptView: "thinking",
    });
    const menu = items.find((item) => item.id === "transcript-view");
    expect(menu?.disabled).toBeUndefined();
    expect(
      menu?.children?.map(({ id, label, checked, disabled }) => ({ id, label, checked, disabled })),
    ).toEqual([
      { id: "transcript-view:normal", label: "Normal", checked: false, disabled: undefined },
      { id: "transcript-view:thinking", label: "Thinking", checked: true, disabled: undefined },
      { id: "transcript-view:verbose", label: "Verbose", checked: false, disabled: undefined },
    ]);
    expect(transcriptViewFromMenuAction("transcript-view:verbose")).toBe("verbose");
    expect(transcriptViewFromMenuAction("transcript-view")).toBeNull();
    expect(transcriptViewFromMenuAction("snooze:custom")).toBeNull();
  });

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
