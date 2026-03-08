import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { ThreadId, type ProviderEvent } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return {
    ...actual,
    spawn: spawnMock,
  };
});

import { ClaudeCodeServerManager } from "./claudeCodeServerManager.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

type FakeChildProcess = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

function createFakeChildProcess(): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

function writeNativeLine(child: FakeChildProcess, payload: unknown): void {
  child.stdout.write(`${JSON.stringify(payload)}\n`);
}

function closeChild(child: FakeChildProcess, code = 0, signal: NodeJS.Signals | null = null): void {
  child.stdout.end();
  child.stderr.end();
  queueMicrotask(() => {
    child.emit("close", code, signal);
  });
}

describe("ClaudeCodeServerManager", () => {
  afterEach(() => {
    spawnMock.mockReset();
  });

  it("preserves exact whitespace in assistant and reasoning deltas while ignoring noop stream families", async () => {
    const child = createFakeChildProcess();
    spawnMock.mockReturnValueOnce(child);

    const manager = new ClaudeCodeServerManager();
    const events: ProviderEvent[] = [];
    manager.on("event", (event: ProviderEvent) => {
      events.push(event);
    });

    const threadId = asThreadId("thread-whitespace");
    await manager.startSession({
      threadId,
      runtimeMode: "full-access",
    });
    await manager.sendTurn({
      threadId,
      input: "Preserve spacing",
    });

    writeNativeLine(child, {
      type: "stream_event",
      event: { type: "message_start", message: { id: "msg_1" } },
    });
    writeNativeLine(child, {
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
    });
    writeNativeLine(child, {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: " let" },
      },
    });
    writeNativeLine(child, {
      type: "stream_event",
      event: { type: "content_block_start", index: 1, content_block: { type: "thinking" } },
    });
    writeNativeLine(child, {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "thinking_delta", thinking: " check" },
      },
    });
    writeNativeLine(child, {
      type: "stream_event",
      event: { type: "message_delta", delta: { stop_reason: null } },
    });
    writeNativeLine(child, {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "signature_delta", signature: "sig_1" },
      },
    });
    writeNativeLine(child, {
      type: "stream_event",
      event: { type: "ping" },
    });
    writeNativeLine(child, {
      type: "result",
      subtype: "success",
      session_id: "sess_whitespace",
    });
    closeChild(child);

    await vi.waitFor(() => {
      expect(events.some((event) => event.method === "turn/completed")).toBe(true);
    });

    expect(
      events
        .filter((event) => event.method === "turn/content-delta")
        .map((event) => event.payload),
    ).toEqual([
      {
        streamKind: "assistant_text",
        delta: " let",
      },
      {
        streamKind: "reasoning_text",
        delta: " check",
      },
    ]);
    expect(events.some((event) => event.method === "runtime/error")).toBe(false);

    manager.stopAll();
  });

  it("accumulates tool input json across mixed Claude delta sequences", async () => {
    const child = createFakeChildProcess();
    spawnMock.mockReturnValueOnce(child);

    const manager = new ClaudeCodeServerManager();
    const events: ProviderEvent[] = [];
    manager.on("event", (event: ProviderEvent) => {
      events.push(event);
    });

    const threadId = asThreadId("thread-tool-json");
    await manager.startSession({
      threadId,
      runtimeMode: "full-access",
    });
    await manager.sendTurn({
      threadId,
      input: "Run the tool",
    });

    writeNativeLine(child, {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_1",
          name: "Bash",
          input: {},
        },
      },
    });
    writeNativeLine(child, {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"command":"echo' },
      },
    });
    writeNativeLine(child, {
      type: "stream_event",
      event: { type: "ping" },
    });
    writeNativeLine(child, {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: ' hi"}' },
      },
    });
    writeNativeLine(child, {
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    });
    writeNativeLine(child, {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "ok",
          },
        ],
      },
    });
    writeNativeLine(child, {
      type: "result",
      subtype: "success",
      session_id: "sess_tool_json",
    });
    closeChild(child);

    await vi.waitFor(() => {
      expect(events.some((event) => event.method === "item/tool/completed")).toBe(true);
    });

    const started = events.find((event) => event.method === "item/tool/started");
    const completed = events.find((event) => event.method === "item/tool/completed");

    expect(started?.payload).toEqual({
      item: {
        type: "tool_use",
        toolName: "Bash",
        input: {
          command: "echo hi",
        },
        summary: "echo hi",
      },
    });
    expect(completed?.payload).toEqual({
      item: {
        type: "tool_use",
        toolName: "Bash",
        status: "completed",
        input: {
          command: "echo hi",
        },
        result: "ok",
        summary: "ok",
      },
    });

    manager.stopAll();
  });

  it("surfaces server tool use and web search results while safely ignoring unknown rich-content families", async () => {
    const child = createFakeChildProcess();
    spawnMock.mockReturnValueOnce(child);

    const manager = new ClaudeCodeServerManager();
    const events: ProviderEvent[] = [];
    manager.on("event", (event: ProviderEvent) => {
      events.push(event);
    });

    const threadId = asThreadId("thread-web-search");
    await manager.startSession({
      threadId,
      runtimeMode: "full-access",
    });
    await manager.sendTurn({
      threadId,
      input: "Search the web",
    });

    writeNativeLine(child, {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "server_tool_use",
          id: "srvtoolu_1",
          name: "web_search",
          input: {},
        },
      },
    });
    writeNativeLine(child, {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"query":"weather nyc"}' },
      },
    });
    writeNativeLine(child, {
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    });
    writeNativeLine(child, {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "future_block",
        },
      },
    });
    writeNativeLine(child, {
      type: "stream_event",
      event: { type: "content_block_stop", index: 1 },
    });
    writeNativeLine(child, {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 2,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_1",
          content: [
            {
              type: "web_search_result",
              title: "Weather in NYC - Example",
              url: "https://example.com/weather",
              encrypted_content: "enc_1",
            },
          ],
        },
      },
    });
    writeNativeLine(child, {
      type: "stream_event",
      event: { type: "content_block_stop", index: 2 },
    });
    writeNativeLine(child, {
      type: "result",
      subtype: "success",
      session_id: "sess_web_search",
    });
    closeChild(child);

    await vi.waitFor(() => {
      expect(events.some((event) => event.method === "item/tool/completed")).toBe(true);
    });

    const updated = events.find((event) => event.method === "item/tool/updated");
    const completed = events.find((event) => event.method === "item/tool/completed");

    expect(
      events.filter((event) => event.method.startsWith("item/tool/")).map((event) => event.method),
    ).toEqual(["item/tool/updated", "item/tool/completed"]);
    expect(updated?.payload).toEqual({
      item: {
        type: "server_tool_use",
        toolName: "web_search",
        input: {
          query: "weather nyc",
        },
        summary: "weather nyc",
      },
    });
    expect(completed?.payload).toEqual({
      item: {
        type: "web_search_tool_result",
        toolName: "web_search",
        status: "completed",
        input: {
          query: "weather nyc",
        },
        result: [
          {
            type: "web_search_result",
            title: "Weather in NYC - Example",
            url: "https://example.com/weather",
            encrypted_content: "enc_1",
          },
        ],
        summary: "Weather in NYC - Example",
      },
    });
    expect(events.some((event) => event.method === "runtime/error")).toBe(false);

    manager.stopAll();
  });

  it("surfaces Claude stream error events immediately as runtime errors", async () => {
    const child = createFakeChildProcess();
    spawnMock.mockReturnValueOnce(child);

    const manager = new ClaudeCodeServerManager();
    const events: ProviderEvent[] = [];
    manager.on("event", (event: ProviderEvent) => {
      events.push(event);
    });

    const threadId = asThreadId("thread-stream-error");
    await manager.startSession({
      threadId,
      runtimeMode: "full-access",
    });
    await manager.sendTurn({
      threadId,
      input: "Trigger an error",
    });

    writeNativeLine(child, {
      type: "stream_event",
      event: {
        type: "error",
        error: {
          type: "overloaded_error",
          message: "Claude stream overloaded",
        },
      },
    });
    closeChild(child, 1);

    await vi.waitFor(() => {
      expect(events.some((event) => event.method === "runtime/error")).toBe(true);
    });

    expect(
      events.find((event) => event.method === "runtime/error"),
    ).toMatchObject({
      kind: "error",
      method: "runtime/error",
      message: "Claude stream overloaded",
      payload: {
        class: "provider_error",
        nativeType: "overloaded_error",
      },
    });

    manager.stopAll();
  });
});