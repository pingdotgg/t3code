import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  limitWindowKey,
  moveLimitItem,
  orderLimitItems,
  UsageLimitLayoutSchema,
} from "./usageLimitLayout";

const decodeLayout = Schema.decodeUnknownSync(UsageLimitLayoutSchema);
const encodeLayout = Schema.encodeSync(UsageLimitLayoutSchema);

describe("usage limit layout", () => {
  it("preserves saved ordering and hidden windows when provider preferences are added", () => {
    const saved = {
      providerOrder: ["claudeAgent"],
      windowOrder: ["weekly"],
      hiddenWindows: ["session"],
    };
    const decoded = decodeLayout(saved);
    expect(decoded).toEqual({ ...saved, hiddenProviders: [], collapsedProviders: [] });
    const updated = {
      ...decoded,
      hiddenProviders: ["cursor"],
      collapsedProviders: ["claudeAgent"],
    };
    expect(decodeLayout(encodeLayout(updated))).toEqual(updated);
  });

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
    const moved = moveLimitItem(saved, ["weekly", "session", "new"], "session", "weekly");
    expect(moved).toEqual(["session", "weekly", "new", "offline"]);
    expect(orderLimitItems(["offline", "new", "weekly", "session"], moved, (id) => id)).toEqual([
      "session",
      "weekly",
      "new",
      "offline",
    ]);
    expect(moveLimitItem(saved, ["weekly", "session", "new"], "new", "weekly")).toEqual([
      "new",
      "weekly",
      "session",
      "offline",
    ]);
    expect(moveLimitItem(saved, ["weekly", "session"], "weekly", "weekly")).toBe(saved);
    expect(moveLimitItem(saved, ["weekly", "session"], "session", "missing")).toBe(saved);
  });
});
