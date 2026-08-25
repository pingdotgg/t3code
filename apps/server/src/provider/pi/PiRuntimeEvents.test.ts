import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { ProviderRuntimeEvent } from "@t3tools/contracts";

import { makePiRuntimeEventMapper } from "./PiRuntimeEvents.ts";

function makeMapper() {
  let id = 0;
  return makePiRuntimeEventMapper({
    providerInstanceId: ProviderInstanceId.make("piAgent"),
    threadId: ThreadId.make("thread-pi-1"),
    now: () => "2026-07-12T00:00:00.000Z",
    nextId: (prefix) => `${prefix}-${++id}`,
  });
}

function expectValid(events: ReadonlyArray<ProviderRuntimeEvent>) {
  const isRuntimeEvent = Schema.is(ProviderRuntimeEvent);
  expect(events.every(isRuntimeEvent)).toBe(true);
}

describe("PiRuntimeEvents", () => {
  it("starts a provider session and thread", () => {
    const mapper = makeMapper();
    const events = mapper.startSession({ sessionId: "pi-session-1", sessionFile: "/tmp/pi.jsonl" });

    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "session.configured",
      "session.state.changed",
      "thread.started",
      "thread.state.changed",
    ]);
    expect(events[0]?.payload).toMatchObject({
      resume: { sessionId: "pi-session-1", sessionFile: "/tmp/pi.jsonl" },
    });
    expectValid(events);
  });

  it("emits OMP runtime events with a separate provider identity", () => {
    const mapper = makePiRuntimeEventMapper({
      provider: ProviderDriverKind.make("omp"),
      providerName: "Oh My Pi",
      providerInstanceId: ProviderInstanceId.make("omp"),
      threadId: ThreadId.make("thread-omp-1"),
      now: () => "2026-08-24T00:00:00.000Z",
    });

    const events = mapper.startSession({ sessionId: "omp-session-1" });

    expect(events.every((event) => event.provider === "omp")).toBe(true);
    expect(events.every((event) => event.providerInstanceId === "omp")).toBe(true);
    expect(events[0]?.payload).toMatchObject({ message: "Oh My Pi RPC session started" });
    expectValid(events);
  });

  it("maps assistant text and thinking deltas into stable content items", () => {
    const mapper = makeMapper();
    const turnId = TurnId.make("turn-pi-1");
    mapper.startTurn({ turnId, model: "openai/gpt-5.5", effort: "high" });

    const text = mapper.map({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello" },
    });
    const thinking = mapper.map({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "Reasoning" },
    });
    const textEnd = mapper.map({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hello" },
    });
    const messageEnd = mapper.map({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Hello" },
          { type: "thinking", thinking: "Reasoning" },
        ],
      },
    });

    expect(text.map((event) => event.type)).toEqual(["item.started", "content.delta"]);
    expect(text[0]?.itemId).toBe(text[1]?.itemId);
    expect(text[1]?.payload).toMatchObject({ streamKind: "assistant_text", delta: "Hello" });
    expect(thinking[1]?.payload).toMatchObject({ streamKind: "reasoning_text" });
    expect(textEnd).toEqual([]);
    expect(messageEnd.map((event) => event.type)).toEqual(["item.completed", "item.completed"]);
    expect(messageEnd[0]).toMatchObject({ itemId: text[0]?.itemId });
    expectValid([...text, ...thinking, ...messageEnd]);
  });

  it("recovers assistant text and reasoning from message_end snapshots", () => {
    const mapper = makeMapper();
    mapper.startTurn({ turnId: TurnId.make("turn-pi-message-end") });

    const events = mapper.map({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Check the protocol" },
          { type: "text", text: "Recovered answer" },
        ],
      },
    });

    expect(events.map((event) => event.type)).toEqual([
      "item.started",
      "content.delta",
      "item.started",
      "content.delta",
      "item.completed",
      "item.completed",
    ]);
    expect(events[1]?.payload).toMatchObject({
      streamKind: "reasoning_text",
      delta: "Check the protocol",
    });
    expect(events[3]?.payload).toMatchObject({
      streamKind: "assistant_text",
      delta: "Recovered answer",
    });
    expect(events[4]?.payload).toMatchObject({ itemType: "reasoning" });
    expect(events[5]?.payload).toMatchObject({ itemType: "assistant_message" });
    expectValid(events);
  });

  it("does not duplicate text already streamed before message_end", () => {
    const mapper = makeMapper();
    mapper.startTurn({ turnId: TurnId.make("turn-pi-message-end-dedup") });
    mapper.map({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello" },
    });
    mapper.map({
      type: "message_update",
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hello" },
    });

    const events = mapper.map({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
    });

    expect(events.map((event) => event.type)).toEqual(["item.completed"]);
  });

  it("emits a longer message_end snapshot before completing its content item", () => {
    const mapper = makeMapper();
    mapper.startTurn({ turnId: TurnId.make("turn-pi-message-end-order") });
    mapper.map({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" },
    });
    const textEnd = mapper.map({
      type: "message_update",
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hel" },
    });

    const events = mapper.map({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
    });

    expect(textEnd).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(["content.delta", "item.completed"]);
    expect(events[0]?.payload).toMatchObject({ delta: "lo" });
    expectValid(events);
  });

  it("closes open reasoning before an interrupted turn", () => {
    const mapper = makeMapper();
    mapper.startTurn({ turnId: TurnId.make("turn-pi-open-reasoning") });
    mapper.map({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Working" },
    });

    const events = mapper.completeTurn("interrupted");

    expect(events.map((event) => event.type)).toEqual([
      "item.completed",
      "turn.completed",
      "thread.state.changed",
    ]);
    expect(events[0]?.payload).toMatchObject({ itemType: "reasoning", status: "completed" });
    expect(events[1]?.payload).toMatchObject({ state: "interrupted" });
    expectValid(events);
  });

  it("closes an open tool and ignores native events that arrive after interruption", () => {
    const mapper = makeMapper();
    mapper.startTurn({ turnId: TurnId.make("turn-pi-late-after-interrupt") });
    mapper.map({
      type: "tool_execution_start",
      toolCallId: "tool-late",
      toolName: "bash",
      args: { command: "sleep 10" },
    });

    const interrupted = mapper.completeTurn("interrupted");
    const lateEvents = [
      ...mapper.map({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Late answer" }],
          stopReason: "aborted",
        },
      }),
      ...mapper.map({
        type: "tool_execution_end",
        toolCallId: "tool-late",
        toolName: "bash",
        result: "late result",
      }),
      ...mapper.map({ type: "agent_end", isTerminal: true, messages: [] }),
    ];

    expect(interrupted.map((event) => event.type)).toEqual([
      "item.completed",
      "turn.completed",
      "thread.state.changed",
    ]);
    expect(interrupted[0]?.payload).toMatchObject({
      itemType: "command_execution",
      status: "failed",
      detail: "Interrupted",
    });
    expect(lateEvents).toEqual([]);
    expectValid(interrupted);
  });

  it.each([
    ["bash", "command_execution"],
    ["write", "file_change"],
    ["edit", "file_change"],
    ["read", "dynamic_tool_call"],
    ["grep", "dynamic_tool_call"],
    ["find", "dynamic_tool_call"],
    ["ls", "dynamic_tool_call"],
    ["custom_extension", "dynamic_tool_call"],
  ] as const)("maps %s tool lifecycle to %s", (toolName, itemType) => {
    const mapper = makeMapper();
    mapper.startTurn({ turnId: TurnId.make("turn-pi-tool") });

    const started = mapper.map({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName,
      args: toolName === "bash" ? { command: "pwd" } : { path: "/tmp/a.ts" },
    });
    const completed = mapper.map({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName,
      result: { content: [{ type: "text", text: "done" }] },
      isError: false,
    });

    expect(started[0]).toMatchObject({
      type: "item.started",
      payload: { itemType, title: toolName, status: "inProgress" },
    });
    expect(completed[0]).toMatchObject({
      type: "item.completed",
      itemId: started[0]?.itemId,
      payload: {
        itemType,
        title: toolName,
        status: "completed",
        data: { toolCallId: "call-1" },
      },
    });
    expectValid([...started, ...completed]);
  });

  it("maps tool updates and failures", () => {
    const mapper = makeMapper();
    mapper.startTurn({ turnId: TurnId.make("turn-pi-tool") });
    mapper.map({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "false" },
    });

    const update = mapper.map({
      type: "tool_execution_update",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "false" },
      partialResult: { content: [{ type: "text", text: "working" }] },
    });
    const failed = mapper.map({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "exit 1" }] },
      isError: true,
    });

    expect(update[0]).toMatchObject({ type: "item.updated", payload: { detail: "working" } });
    expect(failed[0]).toMatchObject({
      type: "item.completed",
      payload: { status: "failed", detail: "exit 1" },
    });
    expectValid([...update, ...failed]);
  });

  it("maps interactive extension requests to user input", () => {
    const mapper = makeMapper();
    mapper.startTurn({ turnId: TurnId.make("turn-pi-input") });

    const events = mapper.map({
      type: "extension_ui_request",
      id: "ui-confirm-1",
      method: "confirm",
      title: "Continue?",
      message: "Run the next step?",
    });

    expect(events[0]).toMatchObject({
      type: "user-input.requested",
      requestId: "ui-confirm-1",
      payload: {
        questions: [
          {
            id: "value",
            header: "Continue?",
            question: "Run the next step?",
            options: [{ label: "Yes" }, { label: "No" }],
          },
        ],
      },
    });
    expectValid(events);
  });

  it("completes the active T3 turn once when the Pi agent settles", () => {
    const mapper = makeMapper();
    mapper.startTurn({ turnId: TurnId.make("turn-pi-end") });

    const ended = mapper.map({ type: "agent_end", messages: [], willRetry: false });
    const completed = mapper.map({ type: "agent_settled" });
    const duplicate = mapper.map({ type: "agent_settled" });

    expect(ended).toEqual([]);
    expect(completed.map((event) => event.type)).toEqual([
      "turn.completed",
      "session.state.changed",
      "thread.state.changed",
    ]);
    expect(completed[0]?.payload).toMatchObject({ state: "completed" });
    expect(duplicate).toEqual([]);
    expectValid(completed);
  });

  it("surfaces an assistant error from agent_end and fails the settled turn", () => {
    const mapper = makeMapper();
    mapper.startTurn({ turnId: TurnId.make("turn-pi-auth-error") });

    const ended = mapper.map({
      type: "agent_end",
      willRetry: false,
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "401 authentication_error",
        },
      ],
    });
    const settled = mapper.map({ type: "agent_settled" });

    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      type: "runtime.error",
      payload: { message: "401 authentication_error", class: "provider_error" },
    });
    expect(settled[0]).toMatchObject({
      type: "turn.completed",
      payload: { state: "failed", errorMessage: "401 authentication_error" },
    });
    expect(settled[1]).toMatchObject({
      type: "session.state.changed",
      payload: { state: "error", reason: "401 authentication_error" },
    });
    expectValid([...ended, ...settled]);
  });

  it("waits through a retried agent run before completing the turn", () => {
    const mapper = makeMapper();
    mapper.startTurn({ turnId: TurnId.make("turn-pi-retry") });

    const retrying = mapper.map({
      type: "agent_end",
      willRetry: true,
      messages: [
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "temporary provider failure",
        },
      ],
    });
    const succeeded = mapper.map({ type: "agent_end", willRetry: false, messages: [] });
    const settled = mapper.map({ type: "agent_settled" });

    expect(retrying).toEqual([]);
    expect(succeeded).toEqual([]);
    expect(settled[0]?.payload).toMatchObject({ state: "completed" });
    expectValid(settled);
  });

  it("uses OMP isTerminal to wait for the final agent run", () => {
    const mapper = makeMapper();
    mapper.startTurn({ turnId: TurnId.make("turn-omp-maintenance") });

    const continuing = mapper.map({
      type: "agent_end",
      isTerminal: false,
      messages: [
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "maintenance continuation",
        },
      ],
    });
    const completed = mapper.map({ type: "agent_end", isTerminal: true, messages: [] });

    expect(continuing).toEqual([]);
    expect(completed[0]?.payload).toMatchObject({ state: "completed" });
    expectValid(completed);
  });

  it("maps a terminal OMP abort to an interrupted turn", () => {
    const mapper = makeMapper();
    mapper.startTurn({ turnId: TurnId.make("turn-omp-aborted") });

    const events = mapper.map({
      type: "agent_end",
      isTerminal: true,
      messages: [
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Still investigating" }],
          stopReason: "aborted",
          errorMessage: "Interrupted by user",
        },
      ],
    });

    expect(events[0]?.payload).toMatchObject({ state: "interrupted" });
    expect(events.some((event) => event.type === "runtime.error")).toBe(false);
    expectValid(events);
  });

  it("preserves a message_end abort when OMP crops agent_end messages", () => {
    const mapper = makeMapper();
    mapper.startTurn({ turnId: TurnId.make("turn-omp-cropped-abort") });

    mapper.map({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Still investigating" }],
        stopReason: "aborted",
        errorMessage: "Interrupted by user",
      },
    });
    const events = mapper.map({ type: "agent_end", isTerminal: true, messages: [] });

    expect(events[0]?.payload).toMatchObject({ state: "interrupted" });
    expect(events.some((event) => event.type === "runtime.error")).toBe(false);
    expectValid(events);
  });

  it("preserves a message_end error when OMP crops agent_end messages", () => {
    const mapper = makeMapper();
    mapper.startTurn({ turnId: TurnId.make("turn-omp-cropped-error") });

    mapper.map({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "OMP provider failed",
      },
    });
    const events = mapper.map({ type: "agent_end", isTerminal: true, messages: [] });

    expect(events[0]).toMatchObject({
      type: "runtime.error",
      payload: { message: "OMP provider failed", class: "provider_error" },
    });
    expect(events[1]?.payload).toMatchObject({
      state: "failed",
      errorMessage: "OMP provider failed",
    });
    expectValid(events);
  });

  it("treats isTerminal as authoritative over a conflicting retry hint", () => {
    const mapper = makeMapper();
    mapper.startTurn({ turnId: TurnId.make("turn-omp-terminal-priority") });

    const events = mapper.map({
      type: "agent_end",
      isTerminal: true,
      willRetry: true,
      messages: [
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "terminal failure",
        },
      ],
    });

    expect(events[0]?.type).toBe("runtime.error");
    expect(events[1]?.payload).toMatchObject({ state: "failed" });
    expectValid(events);
  });

  it("fails instead of succeeding empty when OMP drops an oversized message_end", () => {
    const mapper = makeMapper();
    mapper.startTurn({ turnId: TurnId.make("turn-omp-frame-overflow") });

    const overflow = mapper.map({
      type: "rpc_frame_error",
      originalType: "message_end",
      error: "RPC frame exceeded the transport limit",
    });
    const events = mapper.map({ type: "agent_end", messages: [], messageCount: 0 });

    expect(overflow).toEqual([]);
    expect(events[0]).toMatchObject({
      type: "runtime.error",
      payload: { message: "RPC frame exceeded the transport limit", class: "provider_error" },
    });
    expect(events[1]?.payload).toMatchObject({
      state: "failed",
      errorMessage: "RPC frame exceeded the transport limit",
    });
    expectValid(events);
  });

  it("fails when OMP drops terminal metadata from an oversized agent_end", () => {
    const mapper = makeMapper();
    mapper.startTurn({ turnId: TurnId.make("turn-omp-agent-end-overflow") });

    const events = mapper.map({ type: "agent_end", messages: [], messageCount: 4 });

    expect(events[0]).toMatchObject({
      type: "runtime.error",
      payload: { message: "Pi agent_end exceeded the RPC frame limit", class: "provider_error" },
    });
    expect(events[1]?.payload).toMatchObject({
      state: "failed",
      errorMessage: "Pi agent_end exceeded the RPC frame limit",
    });
    expectValid(events);
  });

  it("keeps compacted OMP agent_end terminal metadata authoritative", () => {
    const mapper = makeMapper();
    mapper.startTurn({ turnId: TurnId.make("turn-omp-compacted-agent-end") });

    const events = mapper.map({
      type: "agent_end",
      messages: [],
      messageCount: 4,
      isTerminal: true,
    });

    expect(events[0]?.payload).toMatchObject({ state: "completed" });
    expect(events.some((event) => event.type === "runtime.error")).toBe(false);
    expectValid(events);
  });

  it("reads the nested assistant error shape from message updates", () => {
    const mapper = makeMapper();
    mapper.startTurn({ turnId: TurnId.make("turn-omp-message-error") });

    mapper.map({
      type: "message_update",
      assistantMessageEvent: {
        type: "error",
        error: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "OMP provider failed",
        },
      },
    });
    const events = mapper.map({ type: "agent_end", isTerminal: true, messages: [] });

    expect(events[0]).toMatchObject({
      type: "runtime.error",
      payload: { message: "OMP provider failed", class: "provider_error" },
    });
    expect(events[1]?.payload).toMatchObject({
      state: "failed",
      errorMessage: "OMP provider failed",
    });
    expectValid(events);
  });

  it("completes a local OMP prompt from prompt_result exactly once", () => {
    const mapper = makeMapper();
    mapper.startTurn({ turnId: TurnId.make("turn-omp-local") });

    const completed = mapper.map({ type: "prompt_result", agentInvoked: false });
    const duplicate = mapper.map({ type: "prompt_result", agentInvoked: false });

    expect(completed[0]?.payload).toMatchObject({ state: "completed" });
    expect(duplicate).toEqual([]);
    expectValid(completed);
  });

  it("keeps legacy Pi versions terminal on agent_end", () => {
    const mapper = makeMapper();
    mapper.startTurn({ turnId: TurnId.make("turn-pi-legacy") });

    const completed = mapper.map({ type: "agent_end", messages: [] });

    expect(completed[0]?.payload).toMatchObject({ state: "completed" });
    expectValid(completed);
  });

  it("reports a fatal runtime error and completes the active turn only once", () => {
    const mapper = makeMapper();
    mapper.startTurn({ turnId: TurnId.make("turn-pi-crash") });

    const failed = mapper.failRuntime("Pi RPC process exited with status 17.");
    const lateAgentEnd = mapper.map({ type: "agent_end", messages: [] });

    expect(failed.map((event) => event.type)).toEqual([
      "runtime.error",
      "turn.completed",
      "session.state.changed",
      "thread.state.changed",
    ]);
    expect(failed[0]?.payload).toMatchObject({
      message: "Pi RPC process exited with status 17.",
      class: "provider_error",
    });
    expect(failed[1]?.payload).toMatchObject({
      state: "failed",
      errorMessage: "Pi RPC process exited with status 17.",
    });
    expect(lateAgentEnd).toEqual([]);
    expectValid(failed);
  });

  it("maps session token statistics", () => {
    const mapper = makeMapper();
    const events = mapper.updateTokenUsage({
      tokens: { input: 120, output: 30, cacheRead: 20, total: 170 },
      toolCalls: 2,
      contextUsage: { contextWindow: 200000 },
    });

    expect(events[0]).toMatchObject({
      type: "thread.token-usage.updated",
      payload: {
        usage: {
          usedTokens: 170,
          inputTokens: 120,
          cachedInputTokens: 20,
          outputTokens: 30,
          maxTokens: 200000,
          toolUses: 2,
        },
      },
    });
    expectValid(events);
  });

  it("clears a prior frame overflow when a later assistant message completes", () => {
    const mapper = makeMapper();
    mapper.startTurn({ turnId: TurnId.make("turn-omp-recovered-frame-overflow") });
    mapper.map({
      type: "rpc_frame_error",
      originalType: "message_end",
      error: "RPC frame exceeded the transport limit",
    });
    mapper.map({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Recovered final answer" }],
        stopReason: "stop",
      },
    });

    const events = mapper.map({ type: "agent_end", isTerminal: true, messages: [] });

    expect(events.some((event) => event.type === "runtime.error")).toBe(false);
    expect(events[0]?.payload).toMatchObject({ state: "completed" });
    expectValid(events);
  });

  it("preserves an interrupted message when Pi settles without agent_end", () => {
    const mapper = makeMapper();
    mapper.startTurn({ turnId: TurnId.make("turn-pi-settled-interrupted") });
    mapper.map({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Stopping" }],
        stopReason: "aborted",
      },
    });

    const events = mapper.map({ type: "agent_settled" });

    expect(events[0]?.payload).toMatchObject({ state: "interrupted" });
    expect(events.some((event) => event.type === "runtime.error")).toBe(false);
    expectValid(events);
  });
});
