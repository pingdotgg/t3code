import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApprovalRequestId, ThreadId } from "@t3tools/contracts";

import {
  buildCodexInitializeParams,
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
  CodexAppServerManager,
  classifyCodexStderrLine,
  isRecoverableThreadResumeError,
  normalizeCodexModelSlug,
  readCodexAccountSnapshot,
  resolveCodexModelForAccount,
} from "./codexAppServerManager";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

function createSendTurnHarness() {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "ready",
      threadId: "thread_1",
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      resumeCursor: { threadId: "thread_1" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    account: {
      type: "unknown",
      planType: null,
      sparkEnabled: true,
    },
    collabReceiverTurns: new Map(),
  };

  const requireSession = vi
    .spyOn(
      manager as unknown as { requireSession: (sessionId: string) => unknown },
      "requireSession",
    )
    .mockReturnValue(context);
  const sendRequest = vi
    .spyOn(
      manager as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> },
      "sendRequest",
    )
    .mockResolvedValue({
      turn: {
        id: "turn_1",
      },
    });
  const updateSession = vi
    .spyOn(manager as unknown as { updateSession: (...args: unknown[]) => void }, "updateSession")
    .mockImplementation(() => {});

  return { manager, context, requireSession, sendRequest, updateSession };
}

function createThreadControlHarness() {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "ready",
      threadId: "thread_1",
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      resumeCursor: { threadId: "thread_1" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    collabReceiverTurns: new Map(),
  };

  const requireSession = vi
    .spyOn(
      manager as unknown as { requireSession: (sessionId: string) => unknown },
      "requireSession",
    )
    .mockReturnValue(context);
  const sendRequest = vi.spyOn(
    manager as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> },
    "sendRequest",
  );
  const updateSession = vi
    .spyOn(manager as unknown as { updateSession: (...args: unknown[]) => void }, "updateSession")
    .mockImplementation(() => {});

  return { manager, context, requireSession, sendRequest, updateSession };
}

function createPendingUserInputHarness() {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "ready",
      threadId: "thread_1",
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      resumeCursor: { threadId: "thread_1" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    pendingUserInputs: new Map([
      [
        ApprovalRequestId.makeUnsafe("req-user-input-1"),
        {
          requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
          jsonRpcId: 42,
          threadId: asThreadId("thread_1"),
        },
      ],
    ]),
    collabReceiverTurns: new Map(),
  };

  const requireSession = vi
    .spyOn(
      manager as unknown as { requireSession: (sessionId: string) => unknown },
      "requireSession",
    )
    .mockReturnValue(context);
  const writeMessage = vi
    .spyOn(manager as unknown as { writeMessage: (...args: unknown[]) => void }, "writeMessage")
    .mockImplementation(() => {});
  const emitEvent = vi
    .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
    .mockImplementation(() => {});

  return { manager, context, requireSession, writeMessage, emitEvent };
}

function createCollabNotificationHarness() {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "running",
      threadId: asThreadId("thread_1"),
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      activeTurnId: "turn_parent",
      resumeCursor: { threadId: "provider_parent" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    account: {
      type: "unknown",
      planType: null,
      sparkEnabled: true,
    },
    pending: new Map(),
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    collabReceiverTurns: new Map<string, string>(),
    nextRequestId: 1,
    stopping: false,
  };

  const emitEvent = vi
    .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
    .mockImplementation(() => {});
  const updateSession = vi
    .spyOn(manager as unknown as { updateSession: (...args: unknown[]) => void }, "updateSession")
    .mockImplementation(() => {});

  return { manager, context, emitEvent, updateSession };
}

describe("classifyCodexStderrLine", () => {
  it("ignores empty lines", () => {
    expect(classifyCodexStderrLine("   ")).toBeNull();
  });

  it("ignores non-error structured codex logs", () => {
    const line =
      "2026-02-08T04:24:19.241256Z  WARN codex_core::features: unknown feature key in config: skills";
    expect(classifyCodexStderrLine(line)).toBeNull();
  });

  it("ignores known benign rollout path errors", () => {
    const line =
      "\u001b[2m2026-02-08T04:24:20.085687Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mcodex_core::rollout::list\u001b[0m: state db missing rollout path for thread 019c3b6c-46b8-7b70-ad23-82f824d161fb";
    expect(classifyCodexStderrLine(line)).toBeNull();
  });

  it("keeps unknown structured errors", () => {
    const line = "2026-02-08T04:24:20.085687Z ERROR codex_core::runtime: unrecoverable failure";
    expect(classifyCodexStderrLine(line)).toEqual({
      message: line,
    });
  });

  it("keeps plain stderr messages", () => {
    const line = "fatal: permission denied";
    expect(classifyCodexStderrLine(line)).toEqual({
      message: line,
    });
  });
});

describe("process stderr events", () => {
  it("emits classified stderr lines as notifications", () => {
    const manager = new CodexAppServerManager();
    const emitEvent = vi
      .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
      .mockImplementation(() => {});

    (
      manager as unknown as {
        emitNotificationEvent: (
          context: { session: { threadId: ThreadId } },
          method: string,
          message: string,
        ) => void;
      }
    ).emitNotificationEvent(
      {
        session: {
          threadId: asThreadId("thread-1"),
        },
      },
      "process/stderr",
      "fatal: permission denied",
    );

    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "notification",
        method: "process/stderr",
        threadId: "thread-1",
        message: "fatal: permission denied",
      }),
    );
  });
});

describe("normalizeCodexModelSlug", () => {
  it("maps 5.3 aliases to gpt-5.3-codex", () => {
    expect(normalizeCodexModelSlug("5.3")).toBe("gpt-5.3-codex");
    expect(normalizeCodexModelSlug("gpt-5.3")).toBe("gpt-5.3-codex");
  });

  it("prefers codex id when model differs", () => {
    expect(normalizeCodexModelSlug("gpt-5.3", "gpt-5.3-codex")).toBe("gpt-5.3-codex");
  });

  it("keeps non-aliased models as-is", () => {
    expect(normalizeCodexModelSlug("gpt-5.2-codex")).toBe("gpt-5.2-codex");
    expect(normalizeCodexModelSlug("gpt-5.2")).toBe("gpt-5.2");
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches not-found resume errors", () => {
    expect(
      isRecoverableThreadResumeError(new Error("thread/resume failed: thread not found")),
    ).toBe(true);
  });

  it("ignores non-resume errors", () => {
    expect(
      isRecoverableThreadResumeError(new Error("thread/start failed: permission denied")),
    ).toBe(false);
  });

  it("ignores non-recoverable resume errors", () => {
    expect(
      isRecoverableThreadResumeError(
        new Error("thread/resume failed: timed out waiting for server"),
      ),
    ).toBe(false);
  });
});

describe("readCodexAccountSnapshot", () => {
  it("disables spark for chatgpt plus accounts", () => {
    expect(
      readCodexAccountSnapshot({
        type: "chatgpt",
        email: "plus@example.com",
        planType: "plus",
      }),
    ).toEqual({
      type: "chatgpt",
      planType: "plus",
      sparkEnabled: false,
    });
  });

  it("keeps spark enabled for chatgpt pro accounts", () => {
    expect(
      readCodexAccountSnapshot({
        type: "chatgpt",
        email: "pro@example.com",
        planType: "pro",
      }),
    ).toEqual({
      type: "chatgpt",
      planType: "pro",
      sparkEnabled: true,
    });
  });

  it("disables spark for api key accounts", () => {
    expect(
      readCodexAccountSnapshot({
        type: "apiKey",
      }),
    ).toEqual({
      type: "apiKey",
      planType: null,
      sparkEnabled: false,
    });
  });

  it("disables spark for unknown chatgpt plans", () => {
    expect(
      readCodexAccountSnapshot({
        type: "chatgpt",
        email: "unknown@example.com",
      }),
    ).toEqual({
      type: "chatgpt",
      planType: "unknown",
      sparkEnabled: false,
    });
  });
});

describe("resolveCodexModelForAccount", () => {
  it("falls back from spark to default for unsupported chatgpt plans", () => {
    expect(
      resolveCodexModelForAccount("gpt-5.3-codex-spark", {
        type: "chatgpt",
        planType: "plus",
        sparkEnabled: false,
      }),
    ).toBe("gpt-5.3-codex");
  });

  it("keeps spark for supported plans", () => {
    expect(
      resolveCodexModelForAccount("gpt-5.3-codex-spark", {
        type: "chatgpt",
        planType: "pro",
        sparkEnabled: true,
      }),
    ).toBe("gpt-5.3-codex-spark");
  });

  it("falls back from spark to default for api key auth", () => {
    expect(
      resolveCodexModelForAccount("gpt-5.3-codex-spark", {
        type: "apiKey",
        planType: null,
        sparkEnabled: false,
      }),
    ).toBe("gpt-5.3-codex");
  });
});

describe("startSession", () => {
  it("enables Codex experimental api capabilities during initialize", () => {
    expect(buildCodexInitializeParams()).toEqual({
      clientInfo: {
        name: "t3code_desktop",
        title: "T3 Code Desktop",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
  });

  it("emits session/startFailed when resolving cwd throws before process launch", async () => {
    const manager = new CodexAppServerManager();
    const events: Array<{ method: string; kind: string; message?: string }> = [];
    manager.on("event", (event) => {
      events.push({
        method: event.method,
        kind: event.kind,
        ...(event.message ? { message: event.message } : {}),
      });
    });

    const processCwd = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("cwd missing");
    });
    try {
      await expect(
        manager.startSession({
          threadId: asThreadId("thread-1"),
          provider: "codex",
          binaryPath: "codex",
          runtimeMode: "full-access",
        }),
      ).rejects.toThrow("cwd missing");
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        method: "session/startFailed",
        kind: "error",
        message: "cwd missing",
      });
    } finally {
      processCwd.mockRestore();
      manager.stopAll();
    }
  });

  it("fails fast with an upgrade message when codex is below the minimum supported version", async () => {
    const manager = new CodexAppServerManager();
    const events: Array<{ method: string; kind: string; message?: string }> = [];
    manager.on("event", (event) => {
      events.push({
        method: event.method,
        kind: event.kind,
        ...(event.message ? { message: event.message } : {}),
      });
    });

    const versionCheck = vi
      .spyOn(
        manager as unknown as {
          assertSupportedCodexCliVersion: (input: {
            binaryPath: string;
            cwd: string;
            homePath?: string;
          }) => void;
        },
        "assertSupportedCodexCliVersion",
      )
      .mockImplementation(() => {
        throw new Error(
          "Codex CLI v0.36.0 is too old for T3 Code. Upgrade to v0.37.0 or newer and restart T3 Code.",
        );
      });

    try {
      await expect(
        manager.startSession({
          threadId: asThreadId("thread-1"),
          provider: "codex",
          binaryPath: "codex",
          runtimeMode: "full-access",
        }),
      ).rejects.toThrow(
        "Codex CLI v0.36.0 is too old for T3 Code. Upgrade to v0.37.0 or newer and restart T3 Code.",
      );
      expect(versionCheck).toHaveBeenCalledTimes(1);
      expect(events).toEqual([
        {
          method: "session/startFailed",
          kind: "error",
          message:
            "Codex CLI v0.36.0 is too old for T3 Code. Upgrade to v0.37.0 or newer and restart T3 Code.",
        },
      ]);
    } finally {
      versionCheck.mockRestore();
      manager.stopAll();
    }
  });
});

describe("sendTurn", () => {
  it("sends text and image user input items to turn/start", async () => {
    const { manager, context, requireSession, sendRequest, updateSession } =
      createSendTurnHarness();

    const result = await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Inspect this image",
      attachments: [
        {
          type: "image",
          url: "data:image/png;base64,AAAA",
        },
      ],
      model: "gpt-5.3",
      serviceTier: "fast",
      effort: "high",
    });

    expect(result).toEqual({
      threadId: "thread_1",
      turnId: "turn_1",
      resumeCursor: { threadId: "thread_1" },
    });
    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      input: [
        {
          type: "text",
          text: "Inspect this image",
          text_elements: [],
        },
        {
          type: "image",
          url: "data:image/png;base64,AAAA",
        },
      ],
      model: "gpt-5.3-codex",
      serviceTier: "fast",
      effort: "high",
    });
    expect(updateSession).toHaveBeenCalledWith(context, {
      status: "running",
      activeTurnId: "turn_1",
      resumeCursor: { threadId: "thread_1" },
    });
  });

  it("supports image-only turns", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      attachments: [
        {
          type: "image",
          url: "data:image/png;base64,BBBB",
        },
      ],
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      input: [
        {
          type: "image",
          url: "data:image/png;base64,BBBB",
        },
      ],
      model: "gpt-5.3-codex",
    });
  });

  it("passes Codex plan mode as a collaboration preset on turn/start", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Plan the work",
      interactionMode: "plan",
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      input: [
        {
          type: "text",
          text: "Plan the work",
          text_elements: [],
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
  });

  it("passes Codex default mode as a collaboration preset on turn/start", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "PLEASE IMPLEMENT THIS PLAN:\n- step 1",
      interactionMode: "default",
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      input: [
        {
          type: "text",
          text: "PLEASE IMPLEMENT THIS PLAN:\n- step 1",
          text_elements: [],
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
  });

  it("keeps the session model when interaction mode is set without an explicit model", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();
    context.session.model = "gpt-5.2-codex";

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Plan this with my current session model",
      interactionMode: "plan",
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      input: [
        {
          type: "text",
          text: "Plan this with my current session model",
          text_elements: [],
        },
      ],
      model: "gpt-5.2-codex",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.2-codex",
          reasoning_effort: "medium",
          developer_instructions: CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
  });

  it("rejects empty turn input", async () => {
    const { manager } = createSendTurnHarness();

    await expect(
      manager.sendTurn({
        threadId: asThreadId("thread_1"),
      }),
    ).rejects.toThrow("Turn input must include text or attachments.");
  });
});

describe("thread checkpoint control", () => {
  it("reads thread turns from thread/read", async () => {
    const { manager, context, requireSession, sendRequest } = createThreadControlHarness();
    sendRequest.mockResolvedValue({
      thread: {
        id: "thread_1",
        turns: [
          {
            id: "turn_1",
            items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
          },
        ],
      },
    });

    const result = await manager.readThread(asThreadId("thread_1"));

    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(sendRequest).toHaveBeenCalledWith(context, "thread/read", {
      threadId: "thread_1",
      includeTurns: true,
    });
    expect(result).toEqual({
      threadId: "thread_1",
      turns: [
        {
          id: "turn_1",
          items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
        },
      ],
    });
  });

  it("reads thread turns from flat thread/read responses", async () => {
    const { manager, context, sendRequest } = createThreadControlHarness();
    sendRequest.mockResolvedValue({
      threadId: "thread_1",
      turns: [
        {
          id: "turn_1",
          items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
        },
      ],
    });

    const result = await manager.readThread(asThreadId("thread_1"));

    expect(sendRequest).toHaveBeenCalledWith(context, "thread/read", {
      threadId: "thread_1",
      includeTurns: true,
    });
    expect(result).toEqual({
      threadId: "thread_1",
      turns: [
        {
          id: "turn_1",
          items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
        },
      ],
    });
  });

  it("rolls back turns via thread/rollback and resets session running state", async () => {
    const { manager, context, sendRequest, updateSession } = createThreadControlHarness();
    sendRequest.mockResolvedValue({
      thread: {
        id: "thread_1",
        turns: [],
      },
    });

    const result = await manager.rollbackThread(asThreadId("thread_1"), 2);

    expect(sendRequest).toHaveBeenCalledWith(context, "thread/rollback", {
      threadId: "thread_1",
      numTurns: 2,
    });
    expect(updateSession).toHaveBeenCalledWith(context, {
      status: "ready",
      activeTurnId: undefined,
    });
    expect(result).toEqual({
      threadId: "thread_1",
      turns: [],
    });
  });
});

describe("respondToUserInput", () => {
  it("serializes canonical answers to Codex native answer objects", async () => {
    const { manager, context, requireSession, writeMessage, emitEvent } =
      createPendingUserInputHarness();

    await manager.respondToUserInput(
      asThreadId("thread_1"),
      ApprovalRequestId.makeUnsafe("req-user-input-1"),
      {
        scope: "All request methods",
        compat: "Keep current envelope",
      },
    );

    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(writeMessage).toHaveBeenCalledWith(context, {
      id: 42,
      result: {
        answers: {
          scope: { answers: ["All request methods"] },
          compat: { answers: ["Keep current envelope"] },
        },
      },
    });
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "item/tool/requestUserInput/answered",
        payload: {
          requestId: "req-user-input-1",
          answers: {
            scope: { answers: ["All request methods"] },
            compat: { answers: ["Keep current envelope"] },
          },
        },
      }),
    );
  });

  it("preserves explicit empty multi-select answers", async () => {
    const { manager, context, requireSession, writeMessage, emitEvent } =
      createPendingUserInputHarness();

    await manager.respondToUserInput(
      asThreadId("thread_1"),
      ApprovalRequestId.makeUnsafe("req-user-input-1"),
      {
        scope: [],
      },
    );

    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(writeMessage).toHaveBeenCalledWith(context, {
      id: 42,
      result: {
        answers: {
          scope: { answers: [] },
        },
      },
    });
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "item/tool/requestUserInput/answered",
        payload: {
          requestId: "req-user-input-1",
          answers: {
            scope: { answers: [] },
          },
        },
      }),
    );
  });

  it("tracks file-read approval requests with the correct method", () => {
    const manager = new CodexAppServerManager();
    const context = {
      session: {
        sessionId: "sess_1",
        provider: "codex",
        status: "ready",
        threadId: asThreadId("thread_1"),
        resumeCursor: { threadId: "thread_1" },
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
    };
    type ApprovalRequestContext = {
      session: typeof context.session;
      pendingApprovals: typeof context.pendingApprovals;
      pendingUserInputs: typeof context.pendingUserInputs;
    };

    (
      manager as unknown as {
        handleServerRequest: (
          context: ApprovalRequestContext,
          request: Record<string, unknown>,
        ) => void;
      }
    ).handleServerRequest(context, {
      jsonrpc: "2.0",
      id: 42,
      method: "item/fileRead/requestApproval",
      params: {},
    });

    const request = Array.from(context.pendingApprovals.values())[0];
    expect(request?.requestKind).toBe("file-read");
    expect(request?.method).toBe("item/fileRead/requestApproval");
  });
});

describe("collab child conversation routing", () => {
  it("rewrites child notification turn ids onto the parent turn", () => {
    const { manager, context, emitEvent } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "call_collab_1",
          receiverThreadIds: ["child_provider_1"],
        },
        threadId: "provider_parent",
        turnId: "turn_parent",
      },
    });

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/agentMessage/delta",
      params: {
        threadId: "child_provider_1",
        turnId: "turn_child_1",
        itemId: "msg_child_1",
        delta: "working",
      },
    });

    expect(emitEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "item/agentMessage/delta",
        turnId: "turn_parent",
        itemId: "msg_child_1",
      }),
    );
  });

  it("suppresses child lifecycle notifications so they cannot replace the parent turn", () => {
    const { manager, context, emitEvent, updateSession } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "call_collab_1",
          receiverThreadIds: ["child_provider_1"],
        },
        threadId: "provider_parent",
        turnId: "turn_parent",
      },
    });
    emitEvent.mockClear();
    updateSession.mockClear();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "turn/started",
      params: {
        threadId: "child_provider_1",
        turn: { id: "turn_child_1" },
      },
    });

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "turn/completed",
      params: {
        threadId: "child_provider_1",
        turn: { id: "turn_child_1", status: "completed" },
      },
    });

    expect(emitEvent).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
  });

  it("rewrites child approval requests onto the parent turn", () => {
    const { manager, context, emitEvent } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "call_collab_1",
          receiverThreadIds: ["child_provider_1"],
        },
        threadId: "provider_parent",
        turnId: "turn_parent",
      },
    });
    emitEvent.mockClear();

    (
      manager as unknown as {
        handleServerRequest: (context: unknown, request: Record<string, unknown>) => void;
      }
    ).handleServerRequest(context, {
      id: 42,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "child_provider_1",
        turnId: "turn_child_1",
        itemId: "call_child_1",
        command: "bun install",
      },
    });

    expect(Array.from(context.pendingApprovals.values())[0]).toEqual(
      expect.objectContaining({
        turnId: "turn_parent",
        itemId: "call_child_1",
      }),
    );
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "item/commandExecution/requestApproval",
        turnId: "turn_parent",
        itemId: "call_child_1",
      }),
    );
  });
});

describe.skipIf(!process.env.CODEX_BINARY_PATH)("startSession live Codex resume", () => {
  it("keeps prior thread history when resuming with a changed runtime mode", async () => {
    const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "codex-live-resume-"));
    writeFileSync(path.join(workspaceDir, "README.md"), "hello\n", "utf8");

    const manager = new CodexAppServerManager();

    try {
      const firstSession = await manager.startSession({
        threadId: asThreadId("thread-live"),
        provider: "codex",
        cwd: workspaceDir,
        runtimeMode: "full-access",
        binaryPath: process.env.CODEX_BINARY_PATH!,
        ...(process.env.CODEX_HOME_PATH ? { homePath: process.env.CODEX_HOME_PATH } : {}),
      });

      const firstTurn = await manager.sendTurn({
        threadId: firstSession.threadId,
        input: `Reply with exactly the word ALPHA ${randomUUID()}`,
      });

      expect(firstTurn.threadId).toBe(firstSession.threadId);

      await vi.waitFor(
        async () => {
          const snapshot = await manager.readThread(firstSession.threadId);
          expect(snapshot.turns.length).toBeGreaterThan(0);
        },
        { timeout: 120_000, interval: 1_000 },
      );

      const firstSnapshot = await manager.readThread(firstSession.threadId);
      const originalThreadId = firstSnapshot.threadId;
      const originalTurnCount = firstSnapshot.turns.length;

      manager.stopSession(firstSession.threadId);

      const resumedSession = await manager.startSession({
        threadId: firstSession.threadId,
        provider: "codex",
        cwd: workspaceDir,
        runtimeMode: "approval-required",
        resumeCursor: firstSession.resumeCursor,
        binaryPath: process.env.CODEX_BINARY_PATH!,
        ...(process.env.CODEX_HOME_PATH ? { homePath: process.env.CODEX_HOME_PATH } : {}),
      });

      expect(resumedSession.threadId).toBe(originalThreadId);

      const resumedSnapshotBeforeTurn = await manager.readThread(resumedSession.threadId);
      expect(resumedSnapshotBeforeTurn.threadId).toBe(originalThreadId);
      expect(resumedSnapshotBeforeTurn.turns.length).toBeGreaterThanOrEqual(originalTurnCount);

      await manager.sendTurn({
        threadId: resumedSession.threadId,
        input: `Reply with exactly the word BETA ${randomUUID()}`,
      });

      await vi.waitFor(
        async () => {
          const snapshot = await manager.readThread(resumedSession.threadId);
          expect(snapshot.turns.length).toBeGreaterThan(originalTurnCount);
        },
        { timeout: 120_000, interval: 1_000 },
      );
    } finally {
      manager.stopAll();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  }, 180_000);
});
