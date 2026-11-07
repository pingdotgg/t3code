import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { v2Projection } from "./orchestrationV2TestFixtures.ts";
import { estimateRetainedThreadBytes } from "./threadRetention.ts";

const withItems = (count: number, bytes: number): OrchestrationV2ThreadProjection => {
  const items = Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
    threadId: v2Projection.thread.id,
    type: "system_notice",
    message: "x".repeat(bytes),
  }));
  return {
    ...v2Projection,
    turnItems: items,
    visibleTurnItems: items.map((item, position) => ({
      position,
      visibility: "local",
      sourceThreadId: v2Projection.thread.id,
      sourceItemId: item.id,
      item,
    })),
  } as unknown as OrchestrationV2ThreadProjection;
};

describe("estimateRetainedThreadBytes", () => {
  it("counts text once for an item the timeline shares, and grows with the items", () => {
    const small = estimateRetainedThreadBytes(withItems(10, 100));
    const large = estimateRetainedThreadBytes(withItems(10, 100_000));
    expect(large - small).toBe(10 * (100_000 - 100));
    expect(estimateRetainedThreadBytes(withItems(20, 100))).toBeGreaterThan(small * 1.9);
  });

  it("charges an inherited row, which no local item shares", () => {
    const local = withItems(1, 1_000);
    const inherited = {
      ...local,
      turnItems: [],
      visibleTurnItems: local.visibleTurnItems.map((row) => ({
        ...row,
        visibility: "inherited",
        sourceThreadId: "parent",
      })),
    } as unknown as OrchestrationV2ThreadProjection;
    expect(estimateRetainedThreadBytes(inherited)).toBeGreaterThan(1_000);
  });

  it("charges a local row that holds its own copy of an item", () => {
    const shared = withItems(1, 1_000);
    const copied = {
      ...shared,
      visibleTurnItems: shared.visibleTurnItems.map((row) => ({ ...row, item: { ...row.item } })),
    } as unknown as OrchestrationV2ThreadProjection;
    const extra = estimateRetainedThreadBytes(copied) - estimateRetainedThreadBytes(shared);
    expect(extra).toBeGreaterThan(1_000);
  });
});
