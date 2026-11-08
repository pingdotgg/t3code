import { describe, expect, it, vi } from "vite-plus/test";

import { buildThreadLifecycleMenuItems } from "./threadLifecycleMenu";

const PRESET = {
  id: "after:60",
  label: "1 hour",
  whenLabel: "3:00 PM",
  snoozedUntil: "2099-01-01T15:00:00.000Z",
} as const;

const noop = () => undefined;

const base = {
  nested: false,
  settlementSupported: false,
  settled: false,
  snoozeSupported: false,
  snoozed: false,
  canSnoozeNow: false,
  presets: [] as const,
  branch: null as string | null,
  newBranchTitle: "New thread on branch",
  pinned: false,
  pinningSupported: false,
  arrangeSupported: false,
  titleRegenerationSupported: false,
  regeneratingTitle: false,
  canTurnIntoProject: false,
  turnIntoProjectDisabled: false,
  autoSettleOptOutSupported: false,
  autoSettleEnabled: true,
  canRename: false,
  onNewThreadOnBranch: noop,
  onCopyThread: noop,
  onCopyThreadId: noop,
  onSettle: noop,
  onUnsettle: noop,
  onWake: noop,
  onSnoozePreset: noop,
  onCustomSnooze: noop,
  onPin: noop,
  onUnpin: noop,
  onArrange: noop,
  onRename: noop,
  onRegenerateTitle: noop,
  onTurnIntoProject: noop,
  onSetAutoSettle: noop,
  onArchive: noop,
  onDelete: noop,
};

const ids = (items: ReturnType<typeof buildThreadLifecycleMenuItems>) =>
  items.map((item) => item.id);

describe("buildThreadLifecycleMenuItems", () => {
  it("offers the full active-thread menu with Settle, Snooze, and secondary actions", () => {
    const onSettle = vi.fn();
    const onSnoozePreset = vi.fn();
    const onRename = vi.fn();
    const items = buildThreadLifecycleMenuItems({
      ...base,
      settlementSupported: true,
      snoozeSupported: true,
      canSnoozeNow: true,
      presets: [PRESET],
      branch: "feat/menu",
      pinningSupported: true,
      arrangeSupported: true,
      titleRegenerationSupported: true,
      canRename: true,
      canTurnIntoProject: true,
      autoSettleOptOutSupported: true,
      onSettle,
      onSnoozePreset,
      onRename,
    });

    expect(ids(items)).toEqual([
      "new-thread-on-branch",
      "copy-thread",
      "copy-thread-id",
      "settle",
      "snooze",
      "pin",
      "arrange",
      "rename",
      "regenerate-title",
      "turn-into-project",
      "auto-settle",
      "archive",
      "delete",
    ]);
    if (!("onPress" in items[3]!)) throw new Error("expected settle action");
    items[3].onPress();
    expect(onSettle).toHaveBeenCalledOnce();

    if (!("items" in items[4]!)) throw new Error("expected snooze submenu");
    expect(items[4].items.map((item) => item.id)).toEqual(["snooze:after:60", "snooze:custom"]);
    if (!("onPress" in items[4].items[0]!)) throw new Error("expected preset action");
    items[4].items[0].onPress();
    expect(onSnoozePreset).toHaveBeenCalledWith("after:60");

    const rename = items.find((item) => item.id === "rename");
    if (!rename || !("onPress" in rename)) throw new Error("expected rename action");
    rename.onPress();
    expect(onRename).toHaveBeenCalledOnce();
  });

  it("nests secondary actions under More on iOS", () => {
    const items = buildThreadLifecycleMenuItems({
      ...base,
      nested: true,
      settlementSupported: true,
      snoozeSupported: true,
      canSnoozeNow: true,
      presets: [PRESET],
      pinningSupported: true,
      arrangeSupported: true,
      canRename: true,
    });

    expect(ids(items)).toEqual([
      "copy-thread",
      "copy-thread-id",
      "settle",
      "snooze",
      "pin",
      "more",
    ]);
    const more = items.at(-1);
    if (!more || !("items" in more)) throw new Error("expected More submenu");
    expect(more.items.map((item) => item.id)).toEqual(["arrange", "rename", "archive", "delete"]);
  });

  it("offers Un-settle and Wake when the thread is settled or snoozed", () => {
    const onUnsettle = vi.fn();
    const onWake = vi.fn();
    const settledItems = buildThreadLifecycleMenuItems({
      ...base,
      settlementSupported: true,
      settled: true,
      canRename: true,
      onUnsettle,
    });
    const snoozedItems = buildThreadLifecycleMenuItems({
      ...base,
      snoozeSupported: true,
      snoozed: true,
      presets: [PRESET],
      pinningSupported: true,
      arrangeSupported: true,
      canRename: true,
      onWake,
    });

    expect(ids(settledItems)).toEqual([
      "copy-thread",
      "copy-thread-id",
      "unsettle",
      "rename",
      "archive",
      "delete",
    ]);
    expect(settledItems[2]).toMatchObject({ id: "unsettle", title: "Un-settle" });
    if (!("onPress" in settledItems[2]!)) throw new Error("expected unsettle action");
    settledItems[2].onPress();
    expect(onUnsettle).toHaveBeenCalledOnce();

    expect(ids(snoozedItems)).toEqual([
      "copy-thread",
      "copy-thread-id",
      "unsnooze",
      "rename",
      "archive",
      "delete",
    ]);
    expect(snoozedItems[2]).toMatchObject({ id: "unsnooze", title: "Wake thread" });
    if (!("onPress" in snoozedItems[2]!)) throw new Error("expected wake action");
    snoozedItems[2].onPress();
    expect(onWake).toHaveBeenCalledOnce();
  });

  it("puts Archive in the direct menu when settlement is unsupported", () => {
    const items = buildThreadLifecycleMenuItems({
      ...base,
      canRename: true,
    });

    expect(ids(items)).toEqual(["copy-thread", "copy-thread-id", "archive", "rename", "delete"]);
  });

  it("disables snooze presets while snooze is gated", () => {
    const items = buildThreadLifecycleMenuItems({
      ...base,
      settlementSupported: true,
      snoozeSupported: true,
      presets: [PRESET],
    });

    const snooze = items.find((item) => item.id === "snooze");
    if (!snooze || !("items" in snooze)) throw new Error("expected snooze submenu");
    expect(snooze.items.every((item) => !("items" in item) && item.disabled === true)).toBe(true);
  });
});
