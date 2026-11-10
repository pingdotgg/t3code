import {
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { decodeSessionUpdateSync } from "./protocol.ts";
import {
  AGENT_MISMATCH_MESSAGE,
  DEFAULT_RESTORE_MESSAGE,
  approvalDecisionToZeroClaw,
  sessionUpdateToEvents,
  splitModelSlug,
  type ProjectionState,
} from "./projection.ts";

function state(): ProjectionState {
  return {
    identity: {
      threadId: ThreadId.make("thread-1"),
      runId: RunId.make("run-1"),
      nodeId: NodeId.make("node-1"),
      providerThreadId: ProviderThreadId.make("pthread-1"),
      providerTurnId: ProviderTurnId.make("pturn-1"),
      providerInstanceId: ProviderInstanceId.make("instance-1"),
      providerSessionId: ProviderSessionId.make("psession-1"),
      ordinal: 1,
    },
    now: DateTime.makeUnsafe(0),
    items: new Map(),
    tools: new Map(),
    subagents: new Map(),
    text: { assistant: "", reasoning: "", settled: "" },
    segment: 0,
    nextOrdinal: 0,
  };
}

function project(input: unknown, current = state()) {
  return sessionUpdateToEvents(current, decodeSessionUpdateSync(input));
}

describe("sessionUpdateToEvents", () => {
  it("projects a message chunk as a streaming assistant item and its message", () => {
    const projected = project({ type: "agent_message_chunk", text: "hello" });
    expect(projected.events.map((event) => event.type)).toEqual([
      "turn_item.updated",
      "message.updated",
    ]);
    expect(projected.events[0]).toMatchObject({
      turnItem: { type: "assistant_message", text: "hello", streaming: true, status: "running" },
    });
    expect(projected.events[1]).toMatchObject({
      message: {
        role: "assistant",
        text: "hello",
        streaming: true,
        threadId: "thread-1",
        runId: "run-1",
      },
    });
  });

  it("accumulates chunks without changing the row identity or creation time", () => {
    const current = state();
    const first = project({ type: "agent_message_chunk", text: "he" }, current);
    const startedAt = current.now;
    current.now = DateTime.makeUnsafe(1_000);
    project({ type: "agent_thought_chunk", text: "thinking" }, current);
    const second = project({ type: "agent_message_chunk", text: "llo" }, current);
    const firstItem = first.events.find((event) => event.type === "turn_item.updated");
    expect(second.events[0]).toMatchObject({
      turnItem: {
        id: firstItem?.turnItem.id,
        ordinal: 1,
        text: "hello",
        startedAt,
        updatedAt: current.now,
      },
    });
    expect(second.events[1]).toMatchObject({
      message: { text: "hello", createdAt: startedAt, updatedAt: current.now },
    });
  });

  it("keeps assistant rows from consecutive turns in the transcript", () => {
    const first = state();
    const second = state();
    const nextTurn = {
      ...second,
      identity: { ...second.identity, providerTurnId: ProviderTurnId.make("pturn-2") },
    };
    const rows = new Map<string, string>();
    for (const [current, text] of [
      [first, "first answer"],
      [nextTurn, "second answer"],
    ] as const) {
      const terminal = project(
        { type: "turn_complete", outcome: "completed", content: text },
        current,
      );
      for (const event of terminal.events) {
        if (event.type === "turn_item.updated" && event.turnItem.type === "assistant_message") {
          rows.set(event.turnItem.id, event.turnItem.text);
        }
      }
    }
    expect([...rows.values()]).toEqual(["first answer", "second answer"]);
  });

  it("projects a thought chunk as streaming reasoning", () => {
    expect(project({ type: "agent_thought_chunk", text: "hmm" }).events[0]).toMatchObject({
      turnItem: { type: "reasoning", text: "hmm", streaming: true },
    });
  });

  it("settles the assistant text with the turn's final content", () => {
    const current = state();
    project({ type: "agent_message_chunk", text: "hel" }, current);
    const terminal = project(
      { type: "turn_complete", outcome: "completed", content: "hello there" },
      current,
    );
    expect(terminal.events.map((event) => event.type)).toEqual([
      "turn_item.updated",
      "message.updated",
      "turn.terminal",
    ]);
    expect(terminal.events[0]).toMatchObject({
      turnItem: { text: "hello there", streaming: false, status: "completed" },
    });
    expect(terminal.events[1]).toMatchObject({
      message: { text: "hello there", streaming: false },
    });
  });

  it("opens a new assistant row for text after a tool call", () => {
    const current = state();
    const rows = new Map<string, { ordinal: number; text?: string; status: string }>();
    const record = (projected: ReturnType<typeof project>) => {
      for (const event of projected.events) {
        if (event.type !== "turn_item.updated") continue;
        const item = event.turnItem;
        rows.set(item.id, {
          ordinal: item.ordinal,
          status: item.status,
          ...(item.type === "assistant_message" ? { text: item.text } : {}),
        });
      }
    };
    record(project({ type: "agent_message_chunk", text: "Checking." }, current));
    record(
      project(
        { type: "tool_call", tool_call_id: "call-1", name: "shell", raw_input: "ls" },
        current,
      ),
    );
    record(project({ type: "agent_message_chunk", text: "Done" }, current));
    record(
      project({ type: "turn_complete", outcome: "completed", content: "Checking.Done." }, current),
    );
    expect([...rows.values()].toSorted((a, b) => a.ordinal - b.ordinal)).toEqual([
      { ordinal: 1, text: "Checking.", status: "completed" },
      { ordinal: 2, status: "running" },
      { ordinal: 3, text: "Done.", status: "completed" },
    ]);
  });

  it("projects a shell tool call as command execution and another tool as dynamic", () => {
    expect(
      project({ type: "tool_call", tool_call_id: "c1", name: "shell", raw_input: "ls" }).events[0],
    ).toMatchObject({
      turnItem: { type: "command_execution", input: "ls", status: "running" },
    });
    expect(
      project({ type: "tool_call", tool_call_id: "c2", name: "read", raw_input: { path: "a" } })
        .events[0],
    ).toMatchObject({
      turnItem: { type: "dynamic_tool", toolName: "read" },
    });
  });

  it("keeps a result on the card its call opened", () => {
    const current = state();
    const opened = project(
      { type: "tool_call", tool_call_id: "c1", name: "read", raw_input: { path: "a" } },
      current,
    );
    const result = project(
      { type: "tool_result", tool_call_id: "c1", status: "failed", raw_output: "nope" },
      current,
    );
    expect(result.events[0]).toMatchObject({
      turnItem: {
        id: (opened.events[0] as { turnItem: { id: string } }).turnItem.id,
        status: "failed",
        output: "nope",
        type: "dynamic_tool",
        toolName: "read",
        input: { path: "a" },
      },
    });
  });

  it("keeps a shell result a command execution with its command line", () => {
    const current = state();
    project({ type: "tool_call", tool_call_id: "c1", name: "shell", raw_input: "ls -la" }, current);
    expect(
      project({ type: "tool_result", tool_call_id: "c1", raw_output: "a\nb" }, current).events[0],
    ).toMatchObject({
      turnItem: {
        type: "command_execution",
        title: "shell",
        input: "ls -la",
        output: "a\nb",
        status: "completed",
      },
    });
  });

  it("projects an approval as a turn item and a live runtime request", () => {
    const projected = project({
      type: "approval_request",
      request_id: "r1",
      tool_name: "shell",
      arguments_summary: "rm -rf",
    });
    expect(projected.events.map((event) => event.type)).toEqual([
      "turn_item.updated",
      "runtime_request.updated",
    ]);
    expect(projected.events[1]).toMatchObject({
      runtimeRequest: {
        responseCapability: { type: "live", providerSessionId: "psession-1" },
      },
    });
  });

  it("projects a plan as a todo list", () => {
    expect(
      project({ type: "plan", entries: [{ content: "step", status: "in_progress" }] }).events[0],
    ).toMatchObject({
      turnItem: { type: "todo_list", steps: [{ text: "step", status: "running" }] },
    });
  });

  it("projects context usage as turn token usage without an event", () => {
    expect(project({ type: "context_usage", input_tokens: 3, max_context_tokens: 9 })).toEqual({
      events: [],
      tokenUsage: { usedTokens: 3, maxTokens: 9 },
    });
  });

  it("projects notices and a terminal outcome", () => {
    expect(
      project({ type: "history_trimmed", reason: "token_budget", dropped_messages: 4 }).events[0],
    ).toMatchObject({
      turnItem: {
        type: "system_notice",
        message: "Context trimmed: token_budget (4 messages dropped)",
      },
    });
    expect(
      project({ type: "budget_warning", current_usd: 4.5, limit_usd: 5 }).events[0],
    ).toMatchObject({
      turnItem: { type: "system_notice", message: "Budget warning: $4.50 of $5.00 spent" },
    });
    expect(project({ type: "turn_complete", outcome: "cancelled" }).events[0]).toMatchObject({
      type: "turn.terminal",
      status: "cancelled",
    });
  });

  it.each([false, true])(
    "allocates a positive failure ordinal after existing output: %s",
    (hasOutput) => {
      const current = state();
      if (hasOutput) project({ type: "agent_message_chunk", text: "partial" }, current);
      const previousOrdinal = current.nextOrdinal;
      const terminal = project(
        { type: "turn_complete", outcome: "failed", content: "boom" },
        current,
      );
      const item = terminal.events.find(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
      );
      expect(item).toMatchObject({
        turnItem: { type: "error", ordinal: previousOrdinal + 1, failure: { message: "boom" } },
      });
      expect(terminal.events.at(-1)).toMatchObject({
        type: "turn.terminal",
        status: "failed",
        failure: { message: "boom" },
        failureItemOrdinal: previousOrdinal + 1,
      });
    },
  );

  it("keeps partial text when a turn is cancelled", () => {
    const current = state();
    project({ type: "agent_message_chunk", text: "half" }, current);
    const terminal = project(
      { type: "turn_complete", outcome: "cancelled", content: "half an answer" },
      current,
    );
    expect(terminal.events[0]).toMatchObject({
      turnItem: { text: "half an answer", streaming: false, status: "cancelled" },
    });
  });

  it("ignores an unknown update type", () => {
    expect(project({ type: "future_event", session_id: "s1" })).toEqual({ events: [] });
  });

  it.each([
    ["completed", "looks good"],
    ["failed", "review failed"],
  ] as const)("retains subagent metadata and child transcript on %s", (status, result) => {
    const initial = state();
    const modelSelection = { instanceId: initial.identity.providerInstanceId, model: "default" };
    const current: ProjectionState = {
      ...initial,
      identity: {
        ...initial.identity,
        modelSelection,
        appThread: {
          createdBy: "user",
          creationSource: "web",
          id: initial.identity.threadId,
          projectId: ProjectId.make("project-1"),
          title: "Parent",
          providerInstanceId: initial.identity.providerInstanceId,
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: initial.identity.threadId,
          },
          forkedFrom: null,
          createdAt: initial.now,
          updatedAt: initial.now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      },
    };
    const opened = project(
      {
        type: "tool_call",
        tool_call_id: "c1",
        name: "spawn_subagent",
        raw_input: { prompt: "review", agent: "reviewer" },
      },
      current,
    );
    expect(opened.events.map((event) => event.type)).toEqual([
      "turn_item.updated",
      "app_thread.created",
      "message.updated",
      "turn_item.updated",
      "subagent.updated",
    ]);
    const nextTurn = project(
      {
        type: "tool_call",
        tool_call_id: "c1",
        name: "spawn_subagent",
        raw_input: { prompt: "next review", agent: "reviewer" },
      },
      {
        ...state(),
        identity: { ...current.identity, providerTurnId: ProviderTurnId.make("turn-2") },
      },
    );
    const ids = (events: typeof opened.events) =>
      events.flatMap<string>((event) => {
        switch (event.type) {
          case "app_thread.created":
            return [event.appThread.id];
          case "message.updated":
            return [event.message.id];
          case "turn_item.updated":
            return [event.turnItem.id];
          case "subagent.updated":
            return [event.subagent.id];
          default:
            return [];
        }
      });
    expect(ids(nextTurn.events).filter((id) => ids(opened.events).includes(id))).toEqual([]);
    const opening = opened.events.find((event) => event.type === "subagent.updated")!;
    current.now = DateTime.makeUnsafe(1_000);
    const settled = project(
      {
        type: "tool_result",
        tool_call_id: "c1",
        name: "spawn_subagent",
        status,
        raw_output: result,
      },
      current,
    );
    expect(settled.events[1]).toMatchObject({
      type: "subagent.updated",
      subagent: {
        ...opening.subagent,
        status,
        result,
        completedAt: current.now,
        updatedAt: current.now,
      },
    });
    expect(settled.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "message.updated",
          message: expect.objectContaining({
            threadId: opening.subagent.childThreadId,
            role: "assistant",
            text: result,
            streaming: false,
          }),
        }),
        expect.objectContaining({
          type: "turn_item.updated",
          turnItem: expect.objectContaining({
            threadId: opening.subagent.childThreadId,
            type: "assistant_message",
            text: result,
            ordinal: 101,
          }),
        }),
      ]),
    );
  });

  it("does not open a subagent for a background delegate", () => {
    const projected = project({
      type: "tool_call",
      tool_call_id: "c1",
      name: "delegate",
      raw_input: { action: "delegate", prompt: "look", background: true },
    });
    expect(projected.events.map((event) => event.type)).toEqual(["turn_item.updated"]);
  });
});

describe("model and approval helpers", () => {
  it("splits a slug and treats default as a sentinel", () => {
    expect(splitModelSlug("openai/gpt")).toEqual({ modelProvider: "openai", model: "gpt" });
    expect(splitModelSlug("default")).toBeNull();
    expect(splitModelSlug("noslash")).toBeNull();
  });

  it("maps approval decisions", () => {
    expect(approvalDecisionToZeroClaw("accept")).toBe("allow_once");
    expect(approvalDecisionToZeroClaw("accept")).toBe("allow_once");
    expect(approvalDecisionToZeroClaw("acceptForSession")).toBe("allow_always");
    expect(approvalDecisionToZeroClaw("decline")).toBe("reject");
    expect(approvalDecisionToZeroClaw("cancel")).toBe("reject");
  });

  it("names the agent and the setting in its failure messages", () => {
    expect(AGENT_MISMATCH_MESSAGE("coder", "reviewer")).toContain("coder");
    expect(DEFAULT_RESTORE_MESSAGE("openai/gpt")).toContain("openai/gpt");
  });
});
