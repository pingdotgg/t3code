import { describe, expect, it } from "vite-plus/test";

import type { AgentRun } from "../../agentRuns.ts";
import { agentRunRowSelector, findAgentRunRowIndex } from "./agentRunJump.logic.ts";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic.ts";

function agentRunRow(taskId: string, createdAt: string): MessagesTimelineRow {
  const run: AgentRun = {
    taskId,
    rowId: `row-${taskId}`,
    createdAt,
    settledAt: null,
    turnId: null,
    title: "Agent run",
    phase: "running",
    ambient: false,
    detailsUnavailable: false,
    feed: [],
  };
  return { kind: "agent-run", id: `agent-run:row-${taskId}`, createdAt, run };
}

function workingRow(id: string): MessagesTimelineRow {
  return { kind: "working", id, createdAt: null };
}

describe("findAgentRunRowIndex", () => {
  it("returns the list index of the run's row, not its position among runs", () => {
    const rows: MessagesTimelineRow[] = [
      workingRow("w1"),
      agentRunRow("task-1", "2026-07-18T00:00:01.000Z"),
      workingRow("w2"),
      agentRunRow("task-2", "2026-07-18T00:00:02.000Z"),
    ];
    expect(findAgentRunRowIndex(rows, "task-2")).toBe(3);
  });

  it("reports -1 when the run has no row — a virtualized jump must not scroll blindly", () => {
    expect(findAgentRunRowIndex([workingRow("w1")], "task-1")).toBe(-1);
    expect(findAgentRunRowIndex([], "task-1")).toBe(-1);
  });
});

describe("agentRunRowSelector", () => {
  it("quotes the task id so an exotic id cannot break out of the attribute selector", () => {
    expect(agentRunRowSelector("task-1")).toBe('[data-agent-run="task-1"]');
    expect(agentRunRowSelector('a"b')).toBe('[data-agent-run="a\\"b"]');
    expect(agentRunRowSelector("a\\b")).toBe('[data-agent-run="a\\\\b"]');
  });
});
