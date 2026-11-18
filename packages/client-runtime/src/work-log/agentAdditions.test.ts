import { describe, expect, it } from "vite-plus/test";

import {
  ThreadId,
  TurnItemId,
  type OrchestrationV2NotificationAddition,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  agentAdditionRunEnd,
  formatAdditionCharacters,
  isAgentAddition,
  summarizeAgentAdditions,
} from "./agentAdditions.js";

function notification(
  id: string,
  addition?: OrchestrationV2NotificationAddition,
  outcome: "updated" | "failed" | "cancelled" = "updated",
): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(id),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-11-18T00:00:00.000Z"),
    type: "notification",
    source: { kind: "system" },
    outcome,
    summary: id,
    ...(addition === undefined ? {} : { addition }),
  };
}

describe("agentAdditionRunEnd", () => {
  it("covers only adjacent marked rows and stops at an unmarked one", () => {
    const items = [
      notification("plain"),
      notification("prompt", { group: "harness", characters: 10 }),
      notification("held", { group: "held" }),
      notification("plain-2"),
      notification("blocked", { group: "blocked" }),
    ];
    const itemOf = (item: OrchestrationV2TurnItem) => item;
    expect(agentAdditionRunEnd(items, 0, itemOf)).toBe(0);
    expect(agentAdditionRunEnd(items, 1, itemOf)).toBe(3);
    expect(agentAdditionRunEnd(items, 4, itemOf)).toBe(5);
  });
});

describe("summarizeAgentAdditions", () => {
  it("orders groups, sums characters per group and warns on a failure or a block", () => {
    const rows = [
      notification("rules", { group: "rules", characters: -18_432 }),
      notification("failed", { group: "rules" }, "failed"),
      notification("added", { group: "harness", characters: 62_673 }),
      notification("prompt", { group: "harness", characters: 17_530 }),
      notification("held-1", { group: "held" }, "cancelled"),
      notification("held-2", { group: "held" }, "cancelled"),
    ]
      .filter(isAgentAddition)
      .map((item) => ({ item }));
    const summary = summarizeAgentAdditions(rows);
    expect(
      summary.groups.map(({ group, rows }) => [group, rows.map(({ item }) => item.id)]),
    ).toEqual([
      ["harness", ["added", "prompt"]],
      ["rules", ["rules", "failed"]],
      ["held", ["held-1", "held-2"]],
    ]);
    expect(summary.chips).toEqual([
      { kind: "harness", value: 80_203 },
      { kind: "rules", value: -18_432 },
      { kind: "held", value: 2 },
      { kind: "failed", value: 1 },
    ]);
    expect(summary.warns).toBe(true);
    expect(summarizeAgentAdditions(rows.slice(2)).warns).toBe(false);
  });
});

describe("formatAdditionCharacters", () => {
  it.each([
    [86, "+86"],
    [92_700, "+92.7k"],
    [-18_432, "−18.4k"],
    [3_000, "+3k"],
    [1_250_000, "+1.3M"],
  ] as const)("formats %d as %s", (characters, expected) => {
    expect(formatAdditionCharacters(characters)).toBe(expected);
  });
});
