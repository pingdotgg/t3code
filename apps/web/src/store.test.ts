import { ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { reducer, type AppState } from "./store";
import { DEFAULT_THREAD_TERMINAL_HEIGHT, DEFAULT_THREAD_TERMINAL_ID, type Thread } from "./types";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    model: "gpt-5-codex",
    terminalOpen: false,
    terminalHeight: DEFAULT_THREAD_TERMINAL_HEIGHT,
    terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
    runningTerminalIds: [],
    activeTerminalId: DEFAULT_THREAD_TERMINAL_ID,
    terminalGroups: [
      {
        id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
      },
    ],
    activeTerminalGroupId: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
    session: null,
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    error: null,
    createdAt: "2026-02-13T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

function makeState(thread: Thread): AppState {
  return {
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        name: "Project",
        cwd: "/tmp/project",
        model: "gpt-5-codex",
        expanded: true,
        scripts: [],
      },
    ],
    threads: [thread],
    threadsHydrated: true,
    runtimeMode: "full-access",
  };
}

describe("store reducer", () => {
  it("marks a completed thread as unread by moving lastVisitedAt before completion", () => {
    const latestTurnCompletedAt = "2026-02-25T12:30:00.000Z";
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-02-25T12:28:00.000Z",
          startedAt: "2026-02-25T12:28:30.000Z",
          completedAt: latestTurnCompletedAt,
          assistantMessageId: null,
        },
        lastVisitedAt: "2026-02-25T12:35:00.000Z",
      }),
    );

    const next = reducer(initialState, {
      type: "MARK_THREAD_UNREAD",
      threadId: ThreadId.makeUnsafe("thread-1"),
    });

    const updatedThread = next.threads[0];
    expect(updatedThread).toBeDefined();
    expect(updatedThread?.lastVisitedAt).toBe("2026-02-25T12:29:59.999Z");
    expect(Date.parse(updatedThread?.lastVisitedAt ?? "")).toBeLessThan(
      Date.parse(latestTurnCompletedAt),
    );
  });

  it("does not change a thread without a completed turn", () => {
    const initialState = makeState(
      makeThread({
        latestTurn: null,
        lastVisitedAt: "2026-02-25T12:35:00.000Z",
      }),
    );

    const next = reducer(initialState, {
      type: "MARK_THREAD_UNREAD",
      threadId: ThreadId.makeUnsafe("thread-1"),
    });

    expect(next).toEqual(initialState);
  });
});

describe("store terminal activity reducer", () => {
  it("adds a terminal to runningTerminalIds when subprocess activity starts", () => {
    const state = makeState(
      makeThread({
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID, "alt"],
        terminalGroups: [
          {
            id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
            terminalIds: [DEFAULT_THREAD_TERMINAL_ID, "alt"],
          },
        ],
      }),
    );
    const next = reducer(state, {
      type: "SET_THREAD_TERMINAL_ACTIVITY",
      threadId: ThreadId.makeUnsafe("thread-1"),
      terminalId: "alt",
      hasRunningSubprocess: true,
    });

    expect(next.threads[0]?.runningTerminalIds).toEqual(["alt"]);
  });

  it("removes a terminal from runningTerminalIds when subprocess activity stops", () => {
    const state = makeState(
      makeThread({
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID, "alt"],
        terminalGroups: [
          {
            id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
            terminalIds: [DEFAULT_THREAD_TERMINAL_ID, "alt"],
          },
        ],
        runningTerminalIds: ["alt"],
      }),
    );
    const next = reducer(state, {
      type: "SET_THREAD_TERMINAL_ACTIVITY",
      threadId: ThreadId.makeUnsafe("thread-1"),
      terminalId: "alt",
      hasRunningSubprocess: false,
    });

    expect(next.threads[0]?.runningTerminalIds).toEqual([]);
  });

  it("ignores activity events for unknown terminal ids", () => {
    const state = makeState(makeThread());
    const next = reducer(state, {
      type: "SET_THREAD_TERMINAL_ACTIVITY",
      threadId: ThreadId.makeUnsafe("thread-1"),
      terminalId: "missing",
      hasRunningSubprocess: true,
    });

    expect(next.threads[0]?.runningTerminalIds).toEqual([]);
  });
});
