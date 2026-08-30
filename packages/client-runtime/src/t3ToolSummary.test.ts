import { describe, expect, it } from "vite-plus/test";

import { summarizeT3ToolCalls, type T3ToolSummaryCall } from "./t3ToolSummary.ts";

function completed(input: unknown, output?: unknown): T3ToolSummaryCall {
  return { input, output, outcome: "completed" };
}

describe("summarizeT3ToolCalls", () => {
  it("counts messages and distinct destinations across delivery modes, deduplicating retries", () => {
    const calls = Array.from({ length: 5 }, (_, i) =>
      completed(
        { threadId: `thread-${i % 2}`, mode: ["auto", "queue", "steer", "restart"][i % 4] },
        { messageId: `message-${i}`, threadId: `thread-${i % 2}` },
      ),
    );
    expect(summarizeT3ToolCalls("thread-send", [...calls, calls[0]!])).toEqual({
      label: "Sent 5 messages to 2 threads",
      failedCount: 0,
      unfinishedCount: 0,
    });
  });

  it("reads provider result envelopes without treating JSON in the message as result data", () => {
    const result = { messageId: "message-1", threadId: "actual-thread" };
    const json = JSON.stringify(result);
    const outputs = [
      result,
      { structuredContent: result },
      [{ type: "text", text: json }],
      { content: [{ text: { text: json } }], isError: false },
      json,
    ];
    const calls = outputs.map((output) =>
      completed(
        {
          toolName: "t3_thread_send",
          args: { threadId: "input-thread", message: '{"threadId":"fake"}' },
        },
        output,
      ),
    );
    expect(summarizeT3ToolCalls("thread-send", calls).label).toBe("Sent 1 message to 1 thread");
    expect(
      summarizeT3ToolCalls("thread-send", [
        completed({ toolName: "t3_thread_send", args: { threadId: "input-thread" } }),
        completed({ threadId: "input-thread" }),
      ]).label,
    ).toBe("Sent 2 messages to 1 thread");
  });

  it("falls back to message counts when a destination is missing or a result is malformed", () => {
    expect(
      summarizeT3ToolCalls("thread-send", [
        completed({ threadId: "known" }),
        completed({ message: '{"threadId":"not-a-destination"}' }, "{truncated"),
        completed(undefined, "Message sent"),
      ]).label,
    ).toBe("Sent 3 messages");
  });

  it("counts batch-created threads, excludes rollbacks, and deduplicates returned thread IDs", () => {
    const threads = Array.from({ length: 4 }, (_, i) => ({
      threadId: `thread-${i}`,
      status: "running",
    }));
    expect(
      summarizeT3ToolCalls("thread-create", [
        completed(
          {},
          { threads: [...threads, { threadId: "rolled-back", status: "rolled_back" }] },
        ),
        completed({}, { threadId: "thread-0", status: "running" }),
      ]).label,
    ).toBe("Created 4 threads");
    expect(
      summarizeT3ToolCalls("thread-create", [
        completed({ threads: [{ title: "Requested, not confirmed" }] }),
      ]).label,
    ).toBe("Requested thread creation 1 time");
  });

  it("excludes failed and unfinished sends even if the provider reports completed", () => {
    const calls: T3ToolSummaryCall[] = [
      completed({ threadId: "success" }, { messageId: "ok", threadId: "success" }),
      completed(
        { threadId: "failed" },
        { isError: true, structuredContent: { threadId: "failed" } },
      ),
      completed({ threadId: "failed" }, [
        { type: "text", text: JSON.stringify({ _tag: "OrchestratorMcpFailure" }) },
      ]),
      { input: { threadId: "cancelled" }, output: undefined, outcome: "unfinished" },
    ];
    expect(summarizeT3ToolCalls("thread-send", calls)).toEqual({
      label: "Sent 1 message to 1 thread",
      failedCount: 2,
      unfinishedCount: 1,
    });
    expect(summarizeT3ToolCalls("thread-send", [calls[1]!])).toEqual({
      label: "Tried to send 1 message to 1 thread",
      failedCount: 1,
      unfinishedCount: 0,
    });
  });

  it("does not confuse a child's failure or wait timeout with failure of the orchestration call", () => {
    const failedChild = { taskId: "task-1", status: "failed", summary: "command not found" };
    expect(
      summarizeT3ToolCalls("delegate", [completed({}, failedChild), completed({}, failedChild)]),
    ).toEqual({
      label: "Delegated 1 task",
      failedCount: 0,
      unfinishedCount: 0,
    });
    expect(
      summarizeT3ToolCalls(
        "task-status",
        Array.from({ length: 4 }, () => completed({ taskId: "task-1" }, failedChild)),
      ).label,
    ).toBe("Checked task status 4 times");
    expect(
      summarizeT3ToolCalls("thread-wait", [
        completed({ threadId: "thread-1" }, { threadId: "thread-1", timedOut: true }),
      ]),
    ).toEqual({
      label: "Waited on 1 thread",
      failedCount: 0,
      unfinishedCount: 0,
    });
  });

  it("describes control requests without claiming that a thread stopped or a task was deleted", () => {
    expect(
      summarizeT3ToolCalls("thread-interrupt", [
        completed(
          { threadId: "thread-1" },
          { threadId: "thread-1", status: "interrupt_requested" },
        ),
      ]).label,
    ).toBe("Requested interrupts for 1 thread");
    expect(
      summarizeT3ToolCalls("task-cancel", [
        completed({ taskId: "task-1" }, { taskId: "task-1", status: "cancel_requested" }),
      ]).label,
    ).toBe("Requested cancellation of 1 task");
    expect(
      summarizeT3ToolCalls("schedule-delete", [
        completed(
          { scheduledTaskId: "schedule-1" },
          { scheduledTaskId: "schedule-1", deleted: false },
        ),
      ]).label,
    ).toBe("Requested deletion of 1 scheduled task");
  });
});
