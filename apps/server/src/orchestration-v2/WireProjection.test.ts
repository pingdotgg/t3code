import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { projectTurnItemForWire } from "./WireProjection.ts";

const base = {
  id: TurnItemId.make("tool-1"),
  type: "dynamic_tool" as const,
  threadId: ThreadId.make("thread-1"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: "MCP tool",
  toolName: "mcp__github__fetch_pr",
  input: { pr: 42 },
  startedAt: DateTime.makeUnsafe("2026-08-13T00:00:00.000Z"),
  completedAt: DateTime.makeUnsafe("2026-08-13T00:00:01.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-08-13T00:00:01.000Z"),
};

describe("orchestration V2 wire projection", () => {
  it("summarizes oversized dynamic tool results without mutating persistence data", () => {
    const output = { content: [{ type: "text", text: "first line\n" + "x".repeat(100_000) }] };
    const item = { ...base, output } satisfies OrchestrationV2TurnItem;
    const projected = projectTurnItemForWire(item);

    expect(item.output).toBe(output);
    expect(projected).not.toBe(item);
    expect(JSON.stringify(projected).length).toBeLessThan(2_000);
    expect(projected.type === "dynamic_tool" ? projected.output : null).toMatchObject({
      truncated: true,
    });
  });

  it("keeps small dynamic tool values intact", () => {
    const item = { ...base, output: { ok: true } } satisfies OrchestrationV2TurnItem;
    expect(projectTurnItemForWire(item)).toEqual(item);
  });

  it("keeps undefined dynamic input intact", () => {
    const item = { ...base, input: undefined } satisfies OrchestrationV2TurnItem;
    expect(projectTurnItemForWire(item)).toEqual(item);
  });
});
