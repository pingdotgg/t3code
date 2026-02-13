import { describe, expect, it } from "vitest";

import type { ProviderEvent, ProviderSession } from "@t3tools/contracts";
import {
  type WorkLogEntry,
  applyEventToMessages,
  derivePendingApprovals,
  deriveTimelineEntries,
  deriveWorkLogEntries,
  evolveSession,
} from "./session-logic";
import type { ChatMessage } from "./types";

function makeEvent(overrides: Partial<ProviderEvent>): ProviderEvent {
  return {
    id: "evt-1",
    kind: "notification",
    provider: "codex",
    sessionId: "sess-1",
    createdAt: "2026-02-08T10:00:00.000Z",
    method: "noop",
    ...overrides,
  };
}

function makeSession(overrides: Partial<ProviderSession> = {}): ProviderSession {
  return {
    sessionId: "sess-1",
    provider: "codex",
    status: "ready",
    createdAt: "2026-02-08T09:59:00.000Z",
    updatedAt: "2026-02-08T09:59:00.000Z",
    ...overrides,
  };
}

describe("deriveTimelineEntries", () => {
  it("interleaves messages and work entries by timestamp", () => {
    const messages: ChatMessage[] = [
      {
        id: "m-user",
        role: "user",
        text: "Hi",
        createdAt: "2026-02-08T10:00:00.000Z",
        streaming: false,
      },
      {
        id: "m-assistant",
        role: "assistant",
        text: "Hello",
        createdAt: "2026-02-08T10:05:00.000Z",
        streaming: false,
      },
    ];
    const workEntries: WorkLogEntry[] = [
      {
        id: "w-1",
        label: "Tool call",
        createdAt: "2026-02-08T10:02:00.000Z",
        tone: "tool",
      },
      {
        id: "w-2",
        label: "Preamble",
        createdAt: "2026-02-08T10:03:00.000Z",
        tone: "thinking",
      },
    ];

    const timeline = deriveTimelineEntries(messages, workEntries);

    expect(timeline.map((entry) => entry.id)).toEqual([
      "message:m-user",
      "work:w-1",
      "work:w-2",
      "message:m-assistant",
    ]);
  });

  it("prefers work entries when timestamps are equal", () => {
    const messages: ChatMessage[] = [
      {
        id: "m-1",
        role: "assistant",
        text: "Done",
        createdAt: "2026-02-08T10:00:00.000Z",
        streaming: false,
      },
    ];
    const workEntries: WorkLogEntry[] = [
      {
        id: "w-1",
        label: "Tool call",
        createdAt: "2026-02-08T10:00:00.000Z",
        tone: "tool",
      },
    ];

    const timeline = deriveTimelineEntries(messages, workEntries);

    expect(timeline.map((entry) => entry.id)).toEqual(["work:w-1", "message:m-1"]);
  });
});

describe("deriveWorkLogEntries", () => {
  it("drops preamble/work events from the visible work log", () => {
    const entries = deriveWorkLogEntries(
      [
        makeEvent({
          id: "evt-1",
          method: "item/started",
          turnId: "turn-1",
          createdAt: "2026-02-08T10:00:00.000Z",
          payload: { item: { type: "preamble", text: "thinking" } },
        }),
        makeEvent({
          id: "evt-2",
          method: "item/started",
          turnId: "turn-1",
          createdAt: "2026-02-08T10:00:01.000Z",
          payload: { item: { type: "work", text: "planning" } },
        }),
        makeEvent({
          id: "evt-3",
          method: "item/started",
          turnId: "turn-1",
          createdAt: "2026-02-08T10:00:02.000Z",
          payload: { item: { type: "tool_call", command: "ls -la" } },
        }),
      ],
      "turn-1",
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Tool call");
  });

  it("does not surface successful turn completion as a work-log row", () => {
    const entries = deriveWorkLogEntries(
      [
        makeEvent({
          id: "evt-start",
          method: "turn/started",
          turnId: "turn-1",
          createdAt: "2026-02-08T10:00:00.000Z",
        }),
        makeEvent({
          id: "evt-complete",
          method: "turn/completed",
          turnId: "turn-1",
          createdAt: "2026-02-08T10:00:10.000Z",
          payload: { turn: { id: "turn-1", status: "completed" } },
        }),
      ],
      "turn-1",
    );

    expect(entries).toHaveLength(0);
  });

  it("shows failed turn completion in the work log", () => {
    const entries = deriveWorkLogEntries(
      [
        makeEvent({
          id: "evt-start",
          method: "turn/started",
          turnId: "turn-1",
          createdAt: "2026-02-08T10:00:00.000Z",
        }),
        makeEvent({
          id: "evt-complete",
          method: "turn/completed",
          turnId: "turn-1",
          createdAt: "2026-02-08T10:00:10.000Z",
          payload: {
            turn: {
              id: "turn-1",
              status: "failed",
              error: { message: "sandbox denied" },
            },
          },
        }),
      ],
      "turn-1",
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Turn failed");
    expect(entries[0]?.detail).toBe("sandbox denied");
  });

  it("hides reasoning and agent-message noise from the visible work log", () => {
    const entries = deriveWorkLogEntries(
      [
        makeEvent({
          id: "evt-turn-start",
          method: "turn/started",
          turnId: "turn-1",
          createdAt: "2026-02-08T10:00:00.000Z",
        }),
        makeEvent({
          id: "evt-summary-part",
          method: "item/reasoning/summaryPartAdded",
          turnId: "turn-1",
          createdAt: "2026-02-08T10:00:01.000Z",
        }),
        makeEvent({
          id: "evt-summary-delta",
          method: "item/reasoning/summaryTextDelta",
          turnId: "turn-1",
          createdAt: "2026-02-08T10:00:02.000Z",
        }),
        makeEvent({
          id: "evt-agent-start",
          method: "item/started",
          turnId: "turn-1",
          createdAt: "2026-02-08T10:00:03.000Z",
          payload: {
            item: { id: "item-msg", type: "agentMessage", text: "Working..." },
          },
        }),
        makeEvent({
          id: "evt-agent-complete",
          method: "item/completed",
          turnId: "turn-1",
          createdAt: "2026-02-08T10:00:04.000Z",
          payload: {
            item: {
              id: "item-msg",
              type: "agentMessage",
              text: "Done response",
            },
          },
        }),
        makeEvent({
          id: "evt-tool-start",
          method: "item/started",
          turnId: "turn-1",
          createdAt: "2026-02-08T10:00:05.000Z",
          payload: {
            item: { id: "item-tool", type: "tool_call", command: "ls -la" },
          },
        }),
        makeEvent({
          id: "evt-tool-complete",
          method: "item/completed",
          turnId: "turn-1",
          createdAt: "2026-02-08T10:00:06.000Z",
          payload: {
            item: { id: "item-tool", type: "tool_call", command: "ls -la" },
          },
        }),
        makeEvent({
          id: "evt-turn-complete",
          method: "turn/completed",
          turnId: "turn-1",
          createdAt: "2026-02-08T10:00:08.000Z",
          payload: { turn: { id: "turn-1", status: "completed" } },
        }),
      ],
      "turn-1",
    );

    expect(entries.map((entry) => entry.label)).toEqual(["Tool call"]);
  });

  it("coalesces command start/completed lifecycle into one entry", () => {
    const entries = deriveWorkLogEntries(
      [
        makeEvent({
          id: "evt-command-start",
          method: "item/started",
          turnId: "turn-1",
          createdAt: "2026-02-08T10:00:01.000Z",
          payload: {
            item: {
              id: "item-command",
              type: "command_execution",
              command: "git status --short",
            },
          },
        }),
        makeEvent({
          id: "evt-command-complete",
          method: "item/completed",
          turnId: "turn-1",
          createdAt: "2026-02-08T10:00:02.000Z",
          payload: {
            item: {
              id: "item-command",
              type: "command_execution",
              command: "git status --short",
            },
          },
        }),
      ],
      "turn-1",
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Command run");
    expect(entries[0]?.detail).toBe("git status --short");
  });

  it("preserves full tool-call detail text without data truncation", () => {
    const longCommand =
      'node ./scripts/sync.js --project ct-round-5 --mode dry-run --include "very long argument with lots of detail and metadata to verify there is no hard truncation in session logic"';
    const entries = deriveWorkLogEntries(
      [
        makeEvent({
          id: "evt-tool-start",
          method: "item/started",
          turnId: "turn-1",
          createdAt: "2026-02-08T10:00:05.000Z",
          payload: {
            item: { id: "item-tool", type: "tool_call", command: longCommand },
          },
        }),
      ],
      "turn-1",
    );

    expect(entries[0]?.detail).toBe(longCommand);
  });

  it("hides generic tool-call rows that have no identifying detail", () => {
    const entries = deriveWorkLogEntries(
      [
        makeEvent({
          id: "evt-tool-start",
          method: "item/started",
          turnId: "turn-1",
          createdAt: "2026-02-08T10:00:05.000Z",
          payload: {
            item: { id: "item-tool", type: "tool_call" },
          },
        }),
      ],
      "turn-1",
    );

    expect(entries).toHaveLength(0);
  });

  it("includes collab tool-call rows with tool name detail", () => {
    const entries = deriveWorkLogEntries(
      [
        makeEvent({
          id: "evt-collab-start",
          method: "item/started",
          turnId: "turn-1",
          createdAt: "2026-02-08T10:00:05.000Z",
          payload: {
            item: {
              id: "item-collab",
              type: "collabAgentToolCall",
              tool: "spawnAgent",
            },
          },
        }),
      ],
      "turn-1",
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Tool call");
    expect(entries[0]?.detail).toBe("spawnAgent");
  });

  it("can derive work-log entries across all turns when not scoped", () => {
    const entries = deriveWorkLogEntries(
      [
        makeEvent({
          id: "evt-turn-1-tool",
          method: "item/started",
          turnId: "turn-1",
          createdAt: "2026-02-08T10:00:01.000Z",
          payload: { item: { type: "tool_call", command: "ls -la" } },
        }),
        makeEvent({
          id: "evt-turn-2-tool",
          method: "item/started",
          turnId: "turn-2",
          createdAt: "2026-02-08T10:00:02.000Z",
          payload: { item: { type: "tool_call", command: "pwd" } },
        }),
      ],
      undefined,
    );

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.detail)).toEqual(["pwd", "ls -la"]);
  });
});

describe("derivePendingApprovals", () => {
  it("returns pending command/file-change approvals", () => {
    const approvals = derivePendingApprovals([
      makeEvent({
        id: "evt-request",
        kind: "request",
        method: "item/commandExecution/requestApproval",
        requestId: "req-1",
        requestKind: "command",
        createdAt: "2026-02-08T10:00:00.000Z",
        payload: { command: "git commit -m 'msg'" },
      }),
    ]);

    expect(approvals).toEqual([
      {
        requestId: "req-1",
        requestKind: "command",
        createdAt: "2026-02-08T10:00:00.000Z",
        detail: "git commit -m 'msg'",
      },
    ]);
  });

  it("removes approvals after a decision event", () => {
    const approvals = derivePendingApprovals([
      makeEvent({
        id: "evt-decision",
        method: "item/requestApproval/decision",
        requestId: "req-1",
        createdAt: "2026-02-08T10:00:01.000Z",
      }),
      makeEvent({
        id: "evt-request",
        kind: "request",
        method: "item/fileChange/requestApproval",
        requestId: "req-1",
        requestKind: "file-change",
        createdAt: "2026-02-08T10:00:00.000Z",
      }),
    ]);

    expect(approvals).toHaveLength(0);
  });

  it("clears pending approvals after turn completion", () => {
    const approvals = derivePendingApprovals([
      makeEvent({
        id: "evt-turn-complete",
        method: "turn/completed",
        createdAt: "2026-02-08T10:00:01.000Z",
        payload: { turn: { id: "turn-1", status: "completed" } },
      }),
      makeEvent({
        id: "evt-request",
        kind: "request",
        method: "item/commandExecution/requestApproval",
        requestId: "req-1",
        requestKind: "command",
        createdAt: "2026-02-08T10:00:00.000Z",
      }),
    ]);

    expect(approvals).toHaveLength(0);
  });
});

describe("evolveSession", () => {
  it("updates thread id when thread starts", () => {
    const previous = makeSession();
    const next = evolveSession(
      previous,
      makeEvent({
        method: "thread/started",
        createdAt: "2026-02-08T10:01:00.000Z",
        payload: { thread: { id: "thread-1" } },
      }),
    );

    expect(next.threadId).toBe("thread-1");
    expect(next.updatedAt).toBe("2026-02-08T10:01:00.000Z");
  });

  it("moves to running and records active turn on turn start", () => {
    const previous = makeSession();
    const next = evolveSession(
      previous,
      makeEvent({
        method: "turn/started",
        turnId: "turn-1",
        createdAt: "2026-02-08T10:02:00.000Z",
      }),
    );

    expect(next.status).toBe("running");
    expect(next.activeTurnId).toBe("turn-1");
    expect(next.updatedAt).toBe("2026-02-08T10:02:00.000Z");
  });

  it("returns to ready and clears active turn on successful completion", () => {
    const previous = makeSession({
      status: "running",
      activeTurnId: "turn-1",
      lastError: "older error",
    });
    const next = evolveSession(
      previous,
      makeEvent({
        method: "turn/completed",
        createdAt: "2026-02-08T10:03:00.000Z",
        payload: { turn: { id: "turn-1", status: "completed" } },
      }),
    );

    expect(next.status).toBe("ready");
    expect(next.activeTurnId).toBeUndefined();
    expect(next.lastError).toBe("older error");
  });

  it("marks session as error when turn fails", () => {
    const previous = makeSession({
      status: "running",
      activeTurnId: "turn-1",
    });
    const next = evolveSession(
      previous,
      makeEvent({
        method: "turn/completed",
        createdAt: "2026-02-08T10:03:00.000Z",
        payload: {
          turn: { id: "turn-1", status: "failed", error: { message: "boom" } },
        },
      }),
    );

    expect(next.status).toBe("error");
    expect(next.activeTurnId).toBeUndefined();
    expect(next.lastError).toBe("boom");
  });

  it("moves to error on runtime error events", () => {
    const previous = makeSession();
    const next = evolveSession(
      previous,
      makeEvent({
        kind: "error",
        method: "runtime/error",
        createdAt: "2026-02-08T10:04:00.000Z",
        message: "runtime failure",
      }),
    );

    expect(next.status).toBe("error");
    expect(next.lastError).toBe("runtime failure");
  });

  it("closes session on close lifecycle events", () => {
    const previous = makeSession({
      status: "running",
      activeTurnId: "turn-1",
    });
    const next = evolveSession(
      previous,
      makeEvent({
        method: "session/closed",
        createdAt: "2026-02-08T10:05:00.000Z",
        message: "closed",
      }),
    );

    expect(next.status).toBe("closed");
    expect(next.activeTurnId).toBeUndefined();
    expect(next.lastError).toBe("closed");
  });
});

describe("applyEventToMessages", () => {
  it("handles start/delta/completed flow for assistant messages", () => {
    const activeAssistantItemRef = { current: null as string | null };
    const started = applyEventToMessages(
      [],
      makeEvent({
        method: "item/started",
        createdAt: "2026-02-08T10:00:00.000Z",
        payload: {
          item: {
            id: "item-1",
            type: "agentMessage",
            text: "Hello",
          },
        },
      }),
      activeAssistantItemRef,
    );

    expect(started).toEqual([
      {
        id: "item-1",
        role: "assistant",
        text: "Hello",
        createdAt: "2026-02-08T10:00:00.000Z",
        streaming: true,
      },
    ]);
    expect(activeAssistantItemRef.current).toBe("item-1");

    const withDelta = applyEventToMessages(
      started,
      makeEvent({
        method: "item/agentMessage/delta",
        createdAt: "2026-02-08T10:00:01.000Z",
        itemId: "item-1",
        textDelta: " world",
      }),
      activeAssistantItemRef,
    );
    expect(withDelta[0]?.text).toBe("Hello world");
    expect(withDelta[0]?.streaming).toBe(true);

    const completed = applyEventToMessages(
      withDelta,
      makeEvent({
        method: "item/completed",
        createdAt: "2026-02-08T10:00:02.000Z",
        payload: {
          item: {
            id: "item-1",
            type: "agentMessage",
            text: "Hello world!",
          },
        },
      }),
      activeAssistantItemRef,
    );
    expect(completed[0]?.text).toBe("Hello world!");
    expect(completed[0]?.streaming).toBe(false);
    expect(activeAssistantItemRef.current).toBeNull();
  });

  it("supports out-of-order delta before started/completed", () => {
    const activeAssistantItemRef = { current: null as string | null };
    const withDelta = applyEventToMessages(
      [],
      makeEvent({
        method: "item/agentMessage/delta",
        createdAt: "2026-02-08T10:00:01.000Z",
        itemId: "item-2",
        textDelta: "Partial",
      }),
      activeAssistantItemRef,
    );
    expect(withDelta[0]?.id).toBe("item-2");
    expect(withDelta[0]?.text).toBe("Partial");
    expect(withDelta[0]?.streaming).toBe(true);
    expect(activeAssistantItemRef.current).toBe("item-2");

    const completed = applyEventToMessages(
      withDelta,
      makeEvent({
        method: "item/completed",
        createdAt: "2026-02-08T10:00:02.000Z",
        payload: {
          item: {
            id: "item-2",
            type: "agentMessage",
            text: "Partial + final",
          },
        },
      }),
      activeAssistantItemRef,
    );

    expect(completed[0]?.text).toBe("Partial + final");
    expect(completed[0]?.streaming).toBe(false);
  });

  it("clears all streaming flags when turn completes", () => {
    const previous: ChatMessage[] = [
      {
        id: "m-user",
        role: "user",
        text: "Hi",
        createdAt: "2026-02-08T10:00:00.000Z",
        streaming: false,
      },
      {
        id: "m-assistant",
        role: "assistant",
        text: "Typing",
        createdAt: "2026-02-08T10:00:01.000Z",
        streaming: true,
      },
    ];

    const next = applyEventToMessages(
      previous,
      makeEvent({
        method: "turn/completed",
      }),
      { current: null },
    );

    expect(next.every((entry) => entry.streaming === false)).toBe(true);
  });
});
