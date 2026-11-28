import { describe, expect, it } from "vite-plus/test";

import {
  moveThreadDetailsBlock,
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

  it("orders blocks from the saved list, keeping unknown ids out and missing ones near their default neighbor", () => {
    expect(
      resolveThreadDetailsOrder({
        threadDetailsOrder: ["relationships", "retired", "environment", "branch", "relationships"],
      }),
    ).toEqual([
      "relationships",
      "usage",
      "context",
      "environment",
      "openIn",
      "scripts",
      "branch",
      "git",
      "repositories",
      "servers",
      "automations",
    ]);
  });

  it("saves an order equal to the default as empty", () => {
    const order = resolveThreadDetailsOrder({ threadDetailsOrder: [] });
    const moved = moveThreadDetailsBlock(order, "usage", "environment");
    expect(moved[0]).toBe("usage");
    expect(
      moveThreadDetailsBlock(
        resolveThreadDetailsOrder({ threadDetailsOrder: moved }),
        "usage",
        "relationships",
      ),
    ).toEqual([]);
    expect(moveThreadDetailsBlock(order, "environment", "openIn").slice(0, 2)).toEqual([
      "openIn",
      "environment",
    ]);
  });
});
