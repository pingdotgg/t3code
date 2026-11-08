import { describe, expect, it, vi } from "vite-plus/test";

import { buildThreadLifecycleMenuItems } from "./threadLifecycleMenu";

const PRESET = {
  id: "after:60",
  label: "1 hour",
  whenLabel: "3:00 PM",
  snoozedUntil: "2099-01-01T15:00:00.000Z",
} as const;

const base = {
  settlementSupported: false,
  settled: false,
  snoozeSupported: false,
  snoozed: false,
  canSnoozeNow: false,
  presets: [] as const,
  canRename: false,
  onSettle: vi.fn(),
  onUnsettle: vi.fn(),
  onWake: vi.fn(),
  onSnoozePreset: vi.fn(),
  onCustomSnooze: vi.fn(),
  onRename: vi.fn(),
};

describe("buildThreadLifecycleMenuItems", () => {
  it("offers Settle, Snooze, and Rename for an active thread", () => {
    const onSettle = vi.fn();
    const onSnoozePreset = vi.fn();
    const onRename = vi.fn();
    const items = buildThreadLifecycleMenuItems({
      ...base,
      settlementSupported: true,
      snoozeSupported: true,
      canSnoozeNow: true,
      presets: [PRESET],
      canRename: true,
      onSettle,
      onSnoozePreset,
      onRename,
    });

    expect(items.map((item) => item.id)).toEqual(["settle", "snooze", "rename"]);
    if (!("onPress" in items[0]!)) throw new Error("expected settle action");
    items[0].onPress();
    expect(onSettle).toHaveBeenCalledOnce();

    if (!("items" in items[1]!)) throw new Error("expected snooze submenu");
    expect(items[1].items.map((item) => item.id)).toEqual(["snooze:after:60", "snooze:custom"]);
    if (!("onPress" in items[1].items[0]!)) throw new Error("expected preset action");
    items[1].items[0].onPress();
    expect(onSnoozePreset).toHaveBeenCalledWith("after:60");

    if (!("onPress" in items[2]!)) throw new Error("expected rename action");
    items[2].onPress();
    expect(onRename).toHaveBeenCalledOnce();
  });

  it("offers Un-settle and Wake when the thread is settled or snoozed", () => {
    const onUnsettle = vi.fn();
    const onWake = vi.fn();
    const settledItems = buildThreadLifecycleMenuItems({
      ...base,
      settlementSupported: true,
      settled: true,
      onUnsettle,
    });
    const snoozedItems = buildThreadLifecycleMenuItems({
      ...base,
      snoozeSupported: true,
      snoozed: true,
      presets: [PRESET],
      onWake,
    });

    expect(settledItems).toHaveLength(1);
    expect(settledItems[0]).toMatchObject({ id: "unsettle", title: "Un-settle thread" });
    if (!("onPress" in settledItems[0]!)) throw new Error("expected unsettle action");
    settledItems[0].onPress();
    expect(onUnsettle).toHaveBeenCalledOnce();

    expect(snoozedItems).toHaveLength(1);
    expect(snoozedItems[0]).toMatchObject({ id: "unsnooze", title: "Wake thread" });
    if (!("onPress" in snoozedItems[0]!)) throw new Error("expected wake action");
    snoozedItems[0].onPress();
    expect(onWake).toHaveBeenCalledOnce();
  });

  it("disables snooze presets while snooze is gated", () => {
    const items = buildThreadLifecycleMenuItems({
      ...base,
      snoozeSupported: true,
      presets: [PRESET],
    });

    if (!("items" in items[0]!)) throw new Error("expected snooze submenu");
    expect(items[0].items.every((item) => !("items" in item) && item.disabled === true)).toBe(true);
  });
});
