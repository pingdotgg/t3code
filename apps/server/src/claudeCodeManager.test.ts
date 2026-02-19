import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClaudeCodeManager } from "./claudeCodeManager";

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual("@anthropic-ai/claude-agent-sdk");
  return {
    ...actual,
    query: vi.fn(),
  };
});

function createIdleQuery(
  models: Array<{ value: string; displayName: string; description: string }> = [],
): Query {
  let closed = false;

  const stream = (async function* streamMessages() {
    while (!closed) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();

  return Object.assign(stream, {
    interrupt: vi.fn(async () => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    setMaxThinkingTokens: vi.fn(async () => undefined),
    initializationResult: vi.fn(async () => ({
      commands: [],
      output_style: "default",
      available_output_styles: ["default"],
      models,
      account: {},
    })),
    supportedCommands: vi.fn(async () => []),
    supportedModels: vi.fn(async () => []),
    mcpServerStatus: vi.fn(async () => []),
    accountInfo: vi.fn(async () => ({})),
    rewindFiles: vi.fn(async () => ({ canRewind: false })),
    reconnectMcpServer: vi.fn(async () => undefined),
    toggleMcpServer: vi.fn(async () => undefined),
    setMcpServers: vi.fn(async () => ({ added: [], removed: [], errors: [] })),
    streamInput: vi.fn(async () => undefined),
    stopTask: vi.fn(async () => undefined),
    close: vi.fn(() => {
      closed = true;
    }),
  }) as unknown as Query;
}

function createStreamingQuery(prompt: AsyncIterable<unknown>): Query {
  let closed = false;

  const stream = (async function* streamMessages() {
    yield { type: "system", subtype: "init", session_id: "claude-thread-1" } as unknown;

    for await (const _message of prompt) {
      if (closed) {
        break;
      }
      yield {
        type: "stream_event",
        session_id: "claude-thread-1",
        event: {
          type: "content_block_delta",
          delta: {
            type: "text_delta",
            text: "Hello",
          },
        },
      } as unknown;
      yield {
        type: "result",
        subtype: "success",
        errors: [],
        session_id: "claude-thread-1",
      } as unknown;
      break;
    }
  })();

  return Object.assign(stream, {
    interrupt: vi.fn(async () => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    setMaxThinkingTokens: vi.fn(async () => undefined),
    initializationResult: vi.fn(async () => ({
      commands: [],
      output_style: "default",
      available_output_styles: ["default"],
      models: [],
      account: {},
    })),
    supportedCommands: vi.fn(async () => []),
    supportedModels: vi.fn(async () => []),
    mcpServerStatus: vi.fn(async () => []),
    accountInfo: vi.fn(async () => ({})),
    rewindFiles: vi.fn(async () => ({ canRewind: false })),
    reconnectMcpServer: vi.fn(async () => undefined),
    toggleMcpServer: vi.fn(async () => undefined),
    setMcpServers: vi.fn(async () => ({ added: [], removed: [], errors: [] })),
    streamInput: vi.fn(async () => undefined),
    stopTask: vi.fn(async () => undefined),
    close: vi.fn(() => {
      closed = true;
    }),
  }) as unknown as Query;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("ClaudeCodeManager", () => {
  it("starts a session and sends a turn", async () => {
    const manager = new ClaudeCodeManager();
    const queryMock = vi.mocked(claudeQuery);
    queryMock.mockReturnValue(
      createIdleQuery([
        {
          value: "claude-sonnet-4-6",
          displayName: "Claude Sonnet 4.6",
          description: "Balanced capability and speed",
        },
      ]),
    );
    vi.spyOn(
      manager as unknown as { assertClaudeAvailable: (binaryPath: string) => void },
      "assertClaudeAvailable",
    ).mockImplementation(() => {});

    const session = await manager.startSession({
      provider: "claudeCode",
      cwd: "/tmp/project",
      model: "sonnet",
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
    });

    expect(session.provider).toBe("claudeCode");
    expect(session.status).toBe("ready");
    expect(session.model).toBe("sonnet");
    expect(session.availableModels).toEqual([
      {
        slug: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        description: "Balanced capability and speed",
      },
    ]);
    expect(session.threadId).toBeUndefined();

    const result = await manager.sendTurn({
      sessionId: session.sessionId,
      input: "Summarize the repository",
    });

    expect(result.turnId).toBeTruthy();
    expect(result.threadId).toBeTruthy();

    manager.stopSession(session.sessionId);
  });

  it("emits codex-compatible assistant item events for streamed text", async () => {
    const manager = new ClaudeCodeManager();
    const queryMock = vi.mocked(claudeQuery);
    queryMock.mockImplementation((input) => {
      const prompt =
        typeof input.prompt === "string" ? (async function* emptyPrompt() {})() : input.prompt;
      return createStreamingQuery(prompt);
    });
    vi.spyOn(
      manager as unknown as { assertClaudeAvailable: (binaryPath: string) => void },
      "assertClaudeAvailable",
    ).mockImplementation(() => {});

    const methods: string[] = [];
    manager.on("event", (event) => {
      methods.push(event.method);
    });

    const session = await manager.startSession({
      provider: "claudeCode",
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
    });
    await manager.sendTurn({
      sessionId: session.sessionId,
      input: "Hi",
    });

    await vi.waitFor(() => {
      expect(methods).toContain("item/agentMessage/delta");
      expect(methods).toContain("item/completed");
    });
    expect(methods).not.toContain("assistant/text");

    manager.stopSession(session.sessionId);
  });

  it("routes canUseTool requests through respondToRequest", async () => {
    const manager = new ClaudeCodeManager();
    const query = createIdleQuery();
    const queryMock = vi.mocked(claudeQuery);
    queryMock.mockReturnValue(query);
    vi.spyOn(
      manager as unknown as { assertClaudeAvailable: (binaryPath: string) => void },
      "assertClaudeAvailable",
    ).mockImplementation(() => {});

    const events: Array<{ kind: string; requestId?: string; method: string }> = [];
    manager.on("event", (event) => {
      events.push({
        kind: event.kind,
        method: event.method,
        ...(event.requestId ? { requestId: event.requestId } : {}),
      });
    });

    const session = await manager.startSession({
      provider: "claudeCode",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
    });

    const firstCall = queryMock.mock.calls[0]?.[0];
    const canUseTool = firstCall?.options?.canUseTool;
    expect(typeof canUseTool).toBe("function");
    if (!canUseTool) {
      manager.stopSession(session.sessionId);
      return;
    }

    const permissionPromise = canUseTool(
      "Bash",
      { command: "ls -la" },
      { signal: new AbortController().signal, toolUseID: "tool-1" },
    );

    await vi.waitFor(() => {
      expect(events.some((event) => event.kind === "request")).toBe(true);
    });

    const request = events.find((event) => event.kind === "request");
    expect(request?.requestId).toBeTruthy();
    if (!request?.requestId) {
      manager.stopSession(session.sessionId);
      return;
    }

    await manager.respondToRequest(session.sessionId, request.requestId, "accept");
    await expect(permissionPromise).resolves.toMatchObject({ behavior: "allow" });

    manager.stopSession(session.sessionId);
  });
});
