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

    expect(text.map((event) => event.type)).toEqual(["item.started", "content.delta"]);
    expect(text[0]?.itemId).toBe(text[1]?.itemId);
    expect(text[1]?.payload).toMatchObject({ streamKind: "assistant_text", delta: "Hello" });
    expect(thinking[1]?.payload).toMatchObject({ streamKind: "reasoning_text" });
    expect(textEnd).toHaveLength(1);
    expect(textEnd[0]).toMatchObject({ type: "item.completed", itemId: text[0]?.itemId });
    expectValid([...text, ...thinking, ...textEnd]);
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
});
