import { describe, expect, it } from "vite-plus/test";

import {
  moveThreadDetailsSection,
  resolveThreadDetailsOrder,
  resolveThreadDetailsVisibility,
  setThreadDetailsItem,
  THREAD_DETAILS_ITEMS,
} from "./threadDetailsItems";

const usage = THREAD_DETAILS_ITEMS.find((item) => item.id === "usage")!;
const servers = THREAD_DETAILS_ITEMS.find((item) => item.id === "servers")!;

describe("thread details items", () => {
  it.each([
    { legacy: false, items: {}, usage: false, context: false },
    { legacy: true, items: {}, usage: true, context: true },
    { legacy: true, items: { usage: false }, usage: false, context: true },
    { legacy: false, items: { usage: true, retired: false }, usage: true, context: false },
  ])("resolves Usage and Context from overrides and the retired Labs flag: %o", (row) => {
    const visibility = resolveThreadDetailsVisibility({
      threadDetailsItems: row.items,
      threadDetailsUsageEnabled: row.legacy,
    });
    expect(visibility.usage).toBe(row.usage);
    expect(visibility.context).toBe(row.context);
    expect(visibility.servers).toBe(true);
  });

  it("stores only choices that differ from the default", () => {
    const legacyOn = { threadDetailsItems: {}, threadDetailsUsageEnabled: true };
    expect(setThreadDetailsItem(legacyOn, usage, false)).toEqual({ usage: false });
    expect(setThreadDetailsItem(legacyOn, usage, true)).toEqual({});

    const hidden = { threadDetailsItems: { servers: false }, threadDetailsUsageEnabled: false };
    expect(setThreadDetailsItem(hidden, servers, true)).toEqual({});
  });

  it("orders sections from the saved list, keeping unknown ids out and missing ones near their default neighbor", () => {
    expect(
      resolveThreadDetailsOrder({
        threadDetailsOrder: [
          "relationships",
          "retired",
          "workspace",
          "versionControl",
          "automations",
          "usage",
          "context",
          "relationships",
        ],
      }),
    ).toEqual([
      "relationships",
      "workspace",
      "versionControl",
      "servers",
      "automations",
      "usage",
      "context",
    ]);
  });

  it("saves an order equal to the default as empty", () => {
    const order = resolveThreadDetailsOrder({ threadDetailsOrder: [] });
    const moved = moveThreadDetailsSection(order, "relationships", -10);
    expect(moved[0]).toBe("relationships");
    expect(
      moveThreadDetailsSection(
        resolveThreadDetailsOrder({ threadDetailsOrder: moved }),
        "relationships",
        4,
      ),
    ).toEqual([]);
  });
});
