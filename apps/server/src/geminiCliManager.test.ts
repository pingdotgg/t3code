import { afterEach, describe, expect, it, vi } from "vitest";

import { GeminiCliManager } from "./geminiCliManager";

function promptText(
  prompt: ReadonlyArray<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>,
): string {
  return prompt
    .filter((entry): entry is { type: "text"; text: string } => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error("Timed out waiting for condition."));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("GeminiCliManager", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reuses a warm ACP runtime for follow-up turns on the same thread", async () => {
    const createdRuntimes: string[] = [];
    const promptCalls: string[] = [];
    const events: Array<Record<string, unknown>> = [];

    const manager = new GeminiCliManager({
      prewarmSessions: false,
      runtimeFactory: async (model, handlers) => {
        createdRuntimes.push(model);
        return {
          model,
          initialize: async () => undefined,
          newSession: vi.fn(async () => ({
            sessionId: `session-${model}`,
            modes: { currentModeId: "default" },
          })),
          loadSession: vi.fn(async (sessionId: string) => ({
            sessionId,
            modes: { currentModeId: "default" },
          })),
          setSessionMode: vi.fn(async () => undefined),
          prompt: vi.fn(async (sessionId: string, prompt) => {
            const text = promptText(prompt);
            promptCalls.push(`${sessionId}:${text}`);
            handlers.onSessionUpdate({
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: `reply:${text}` },
              },
            });
            return { stopReason: "end_turn" };
          }),
          cancel: vi.fn(async () => undefined),
          close: vi.fn(() => undefined),
        };
      },
    });

    manager.on("event", (event: Record<string, unknown>) => {
      events.push(event);
    });

    manager.startSession({
      threadId: "thread-1",
      model: "gemini-3-flash-preview",
      cwd: process.cwd(),
    });

    manager.sendTurn({
      threadId: "thread-1",
      text: "first",
      approvalMode: "yolo",
    });

    await waitFor(() => promptCalls.length === 1);

    manager.sendTurn({
      threadId: "thread-1",
      text: "second",
      approvalMode: "yolo",
    });

    await waitFor(() => promptCalls.length === 2);

    expect(createdRuntimes).toEqual(["gemini-3-flash-preview"]);
    expect(promptCalls).toEqual([
      "session-gemini-3-flash-preview:first",
      "session-gemini-3-flash-preview:second",
    ]);

    const configuredEvents = events.filter((event) => event.method === "session/configured");
    expect(configuredEvents).toHaveLength(1);

    const messageEvents = events.filter((event) => event.method === "gemini/message");
    expect(messageEvents).toHaveLength(2);
  });

  it("loads a persisted Gemini session without replaying hydrated history into live events", async () => {
    const events: Array<Record<string, unknown>> = [];
    const manager = new GeminiCliManager({
      prewarmSessions: false,
      runtimeFactory: async (_model, handlers) => ({
        model: "gemini-2.5-pro",
        initialize: async () => undefined,
        newSession: vi.fn(async () => ({ sessionId: "new-session", modes: { currentModeId: "default" } })),
        loadSession: vi.fn(async (sessionId: string) => {
          handlers.onSessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "old-history" },
            },
          });
          return { sessionId, modes: { currentModeId: "default" } };
        }),
        setSessionMode: vi.fn(async () => undefined),
        prompt: vi.fn(async (sessionId: string) => {
          handlers.onSessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "fresh-reply" },
            },
          });
          return { stopReason: "end_turn" };
        }),
        cancel: vi.fn(async () => undefined),
        close: vi.fn(() => undefined),
      }),
    });

    manager.on("event", (event: Record<string, unknown>) => {
      events.push(event);
    });

    manager.startSession({
      threadId: "thread-2",
      model: "gemini-2.5-pro",
      cwd: process.cwd(),
      resumeCursor: { sessionId: "persisted-session" },
    });

    manager.sendTurn({
      threadId: "thread-2",
      text: "continue",
      approvalMode: "yolo",
    });

    await waitFor(
      () => events.some((event) => event.method === "gemini/message" && event.content === "fresh-reply"),
    );

    const messageContents = events
      .filter((event) => event.method === "gemini/message")
      .map((event) => event.content);

    expect(messageContents).toEqual(["fresh-reply"]);
  });

  it("emits thought, plan, and incremental tool update events during an ACP turn", async () => {
    const events: Array<Record<string, unknown>> = [];
    const manager = new GeminiCliManager({
      prewarmSessions: false,
      runtimeFactory: async (_model, handlers) => ({
        model: "gemini-2.5-pro",
        initialize: async () => undefined,
        newSession: vi.fn(async () => ({
          sessionId: "session-live-events",
          modes: { currentModeId: "default" },
        })),
        loadSession: vi.fn(async (sessionId: string) => ({
          sessionId,
          modes: { currentModeId: "default" },
        })),
        setSessionMode: vi.fn(async () => undefined),
        prompt: vi.fn(async (sessionId: string) => {
          handlers.onSessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: "Inspecting files" },
            },
          });
          handlers.onSessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "plan",
              entries: [
                { content: "Inspect files", status: "completed", priority: "high" },
                { content: "Apply patch", status: "in_progress", priority: "high" },
              ],
            },
          });
          handlers.onSessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tool-1",
              title: "Edit app shell",
              kind: "edit",
              status: "pending",
              locations: [{ path: "apps/web/src/components/ChatView.tsx", line: 10 }],
            },
          });
          handlers.onSessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tool-1",
              title: "Edit app shell",
              kind: "edit",
              status: "in_progress",
              locations: [{ path: "apps/web/src/components/ChatView.tsx", line: 10 }],
              content: [{ type: "diff", path: "apps/web/src/components/ChatView.tsx" }],
            },
          });
          handlers.onSessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Done." },
            },
          });
          return { stopReason: "end_turn" };
        }),
        cancel: vi.fn(async () => undefined),
        close: vi.fn(() => undefined),
      }),
    });

    manager.on("event", (event: Record<string, unknown>) => {
      events.push(event);
    });

    manager.startSession({
      threadId: "thread-live-events",
      model: "gemini-2.5-pro",
      cwd: process.cwd(),
    });

    manager.sendTurn({
      threadId: "thread-live-events",
      text: "fix the ui",
      approvalMode: "yolo",
    });

    await waitFor(() => events.some((event) => event.method === "gemini/result"));

    expect(events.some((event) => event.method === "gemini/thought")).toBe(true);
    expect(events.some((event) => event.method === "gemini/plan")).toBe(true);
    expect(
      events.some(
        (event) => event.method === "gemini/tool_update" && event.status === "in_progress",
      ),
    ).toBe(true);
  });

  it("passes image prompt blocks through to the ACP runtime", async () => {
    const seenPrompts: Array<ReadonlyArray<Record<string, unknown>>> = [];
    const manager = new GeminiCliManager({
      prewarmSessions: false,
      runtimeFactory: async (_model, handlers) => ({
        model: "gemini-2.5-pro",
        initialize: async () => undefined,
        newSession: vi.fn(async () => ({
          sessionId: "session-image",
          modes: { currentModeId: "default" },
        })),
        loadSession: vi.fn(async (sessionId: string) => ({
          sessionId,
          modes: { currentModeId: "default" },
        })),
        setSessionMode: vi.fn(async () => undefined),
        prompt: vi.fn(async (_sessionId: string, prompt) => {
          seenPrompts.push(prompt as ReadonlyArray<Record<string, unknown>>);
          handlers.onSessionUpdate({
            sessionId: "session-image",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "saw image" },
            },
          });
          return { stopReason: "end_turn" };
        }),
        cancel: vi.fn(async () => undefined),
        close: vi.fn(() => undefined),
      }),
    });

    manager.startSession({
      threadId: "thread-image",
      model: "gemini-2.5-pro",
      cwd: process.cwd(),
    });

    manager.sendTurn({
      threadId: "thread-image",
      text: "describe this image",
      prompt: [
        { type: "text", text: "describe this image" },
        { type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
      ],
      approvalMode: "yolo",
    });

    await waitFor(() => seenPrompts.length === 1);
    expect(seenPrompts[0]?.some((entry) => entry.type === "image")).toBe(true);
  });

  it("preserves the text instruction when prompt attachments omit a text block", async () => {
    const seenPrompts: Array<ReadonlyArray<Record<string, unknown>>> = [];
    const manager = new GeminiCliManager({
      prewarmSessions: false,
      runtimeFactory: async (_model, handlers) => ({
        model: "gemini-2.5-pro",
        initialize: async () => undefined,
        newSession: vi.fn(async () => ({
          sessionId: "session-image-no-text",
          modes: { currentModeId: "default" },
        })),
        loadSession: vi.fn(async (sessionId: string) => ({
          sessionId,
          modes: { currentModeId: "default" },
        })),
        setSessionMode: vi.fn(async () => undefined),
        prompt: vi.fn(async (_sessionId: string, prompt) => {
          seenPrompts.push(prompt as ReadonlyArray<Record<string, unknown>>);
          handlers.onSessionUpdate({
            sessionId: "session-image-no-text",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "processed prompt" },
            },
          });
          return { stopReason: "end_turn" };
        }),
        cancel: vi.fn(async () => undefined),
        close: vi.fn(() => undefined),
      }),
    });

    manager.startSession({
      threadId: "thread-image-no-text",
      model: "gemini-2.5-pro",
      cwd: process.cwd(),
    });

    manager.sendTurn({
      threadId: "thread-image-no-text",
      text: "analyze the attached screenshot",
      prompt: [{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }],
      approvalMode: "yolo",
    });

    await waitFor(() => seenPrompts.length === 1);
    expect(seenPrompts[0]).toEqual([
      { type: "text", text: "analyze the attached screenshot" },
      { type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
    ]);
  });
});
