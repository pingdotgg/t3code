import { describe, expect, it } from "vite-plus/test";
import { TurnId } from "@t3tools/contracts";

import type { AcpToolCallState } from "./AcpRuntimeModel.ts";
import { cursorSubagentTaskEvents, type CursorSubagentRecord } from "./CursorSubagents.ts";

const turnId = TurnId.make("turn-1");

function tool(overrides: Partial<AcpToolCallState> = {}): AcpToolCallState {
  return {
    toolCallId: "call-1",
    kind: "other",
    title: "Task: Clip identity and ingest",
    status: "pending",
    data: {
      rawInput: {
        _toolName: "task",
        description: "Clip identity and ingest",
        prompt: "do the work",
        subagentType: { unspecified: {} },
      },
    },
    ...overrides,
  };
}

function run(calls: ReadonlyArray<AcpToolCallState>) {
  const tasks = new Map<string, CursorSubagentRecord>();
  return calls.flatMap((toolCall) => cursorSubagentTaskEvents({ tasks, toolCall, turnId }));
}

describe("Cursor Task subagents", () => {
  it("starts a roster row from the task tool and ignores ordinary tools", () => {
    const events = run([
      tool(),
      tool({
        toolCallId: "read-1",
        kind: "read",
        title: "Read File",
        data: { rawInput: { path: "README.md" } },
      }),
    ]);
    expect(events).toEqual([
      {
        type: "task.started",
        turnId,
        payload: {
          taskId: "call-1",
          taskType: "local_agent",
          toolUseId: "call-1",
          title: "Clip identity and ingest",
          description: "Clip identity and ingest",
        },
      },
    ]);
  });

  it("keeps one row through running and completed, and uses a string role", () => {
    const events = run([
      tool(),
      tool({ status: "inProgress" }),
      tool({
        status: "inProgress",
        data: {
          rawInput: {
            _toolName: "task",
            description: "Clip identity and ingest",
            subagentType: "generalPurpose",
          },
        },
      }),
      tool({ status: "completed" }),
      tool({ status: "completed" }),
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "task.started",
      "task.progress",
      "task.progress",
      "task.completed",
    ]);
    expect(events[2]?.payload).toMatchObject({
      role: "generalPurpose",
      status: "running",
    });
    expect(events[3]?.payload).toMatchObject({ status: "completed" });
  });

  it("emits start and completion together when the first update is already finished", () => {
    const events = run([
      tool({
        status: "failed",
        title: "Task: Subagent task",
        data: { rawInput: { _toolName: "task" } },
      }),
    ]);
    expect(events.map((event) => event.type)).toEqual(["task.started", "task.completed"]);
    expect(events[1]?.payload).toMatchObject({
      title: "Subagent task",
      status: "failed",
    });
  });
});
