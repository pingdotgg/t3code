import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind } from "@t3tools/contracts";

import {
  buildThreadActionMenuItems,
  nativeThreadProviderName,
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
  nativeThreadProviderName: null,
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

  it("offers the provider's own thread id only once the provider reported one", () => {
    const copyChildren = (state: ThreadActionMenuState) =>
      buildThreadActionMenuItems(state).find((item) => item.id === "copy")?.children ?? [];

    expect(copyChildren(baseState).map((child) => child.id)).not.toContain("copy-native-thread-id");
    const item = copyChildren({
      ...baseState,
      canOperate: false,
      nativeThreadProviderName: "OpenCode",
    }).find((child) => child.id === "copy-native-thread-id");
    expect(item?.label).toBe("OpenCode Thread ID");
    expect(item?.disabled).toBeFalsy();
  });
});

describe("nativeThreadProviderName", () => {
  it("names the provider that owns the id, and nothing before the id exists", () => {
    const ref = { driver: ProviderDriverKind.make("opencode"), strength: "strong" } as const;
    expect(nativeThreadProviderName({ ...ref, nativeId: "ses_1" })).toBe("OpenCode");
    expect(nativeThreadProviderName({ ...ref, nativeId: null })).toBeNull();
    expect(nativeThreadProviderName(null)).toBeNull();
  });
});
