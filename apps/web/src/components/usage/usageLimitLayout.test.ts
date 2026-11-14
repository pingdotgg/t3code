import { describe, expect, it } from "vite-plus/test";

import { limitWindowKey, moveLimitItem, orderLimitItems } from "./usageLimitLayout";

describe("usage limit layout", () => {
  it("orders saved cards first and appends new cards in their default order", () => {
    expect(
      orderLimitItems(["new", "weekly", "session", "other"], ["session", "weekly"], (id) => id),
    ).toEqual(["session", "weekly", "new", "other"]);
    expect(limitWindowKey("claude", { kind: "weekly", id: "shared" })).not.toBe(
      limitWindowKey("antigravity", { kind: "weekly", id: "shared" }),
    );
  });

  it("moves available cards without forgetting temporarily unavailable preferences", () => {
    const saved = ["offline", "weekly", "session"];
    const moved = moveLimitItem(saved, ["weekly", "session", "new"], "session", -1);
    expect(moved).toEqual(["session", "weekly", "new", "offline"]);
    expect(orderLimitItems(["offline", "new", "weekly", "session"], moved, (id) => id)).toEqual([
      "session",
      "weekly",
      "new",
      "offline",
    ]);
    expect(moveLimitItem(saved, ["weekly", "session"], "weekly", -1)).toBe(saved);
    expect(moveLimitItem(saved, ["weekly", "session"], "session", 1)).toBe(saved);
  });
});
