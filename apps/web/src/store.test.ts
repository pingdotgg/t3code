import type { ProviderEvent, ProviderSession } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { type AppState, reducer } from "./store";
import { DEFAULT_THREAD_TERMINAL_HEIGHT, DEFAULT_THREAD_TERMINAL_ID } from "./types";
import type { Thread } from "./types";

function makeSession(overrides: Partial<ProviderSession> = {}): ProviderSession {
  return {
    sessionId: "sess-1",
    provider: "codex",
    status: "ready",
    createdAt: "2026-02-09T00:00:00.000Z",
    updatedAt: "2026-02-09T00:00:00.000Z",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<ProviderEvent> = {}): ProviderEvent {
  return {
    id: "evt-1",
    kind: "notification",
    provider: "codex",
    sessionId: "sess-1",
    createdAt: "2026-02-09T00:00:01.000Z",
    method: "thread/started",
    ...overrides,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-local-1",
    codexThreadId: null,
    projectId: "project-1",
    title: "Thread",
    model: "gpt-5.3-codex",
    terminalOpen: false,
    terminalHeight: DEFAULT_THREAD_TERMINAL_HEIGHT,
    terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
    activeTerminalId: DEFAULT_THREAD_TERMINAL_ID,
    terminalLayout: "single",
    splitTerminalIds: [],
    session: makeSession(),
    messages: [],
    events: [],
    error: null,
    createdAt: "2026-02-09T00:00:00.000Z",
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

function makeState(thread: Thread): AppState {
  return {
    projects: [
      {
        id: "project-1",
        name: "Project",
        cwd: "/tmp/project",
        model: "gpt-5.3-codex",
        expanded: true,
      },
    ],
    threads: [thread],
    activeThreadId: thread.id,
    runtimeMode: "full-access",
    diffOpen: false,
  };
}

describe("store reducer thread continuity", () => {
  it("stores codexThreadId from UPDATE_SESSION", () => {
    const state = makeState(
      makeThread({
        session: null,
      }),
    );
    const next = reducer(state, {
      type: "UPDATE_SESSION",
      threadId: "thread-local-1",
      session: makeSession({ threadId: "thr_123" }),
    });

    expect(next.threads[0]?.codexThreadId).toBe("thr_123");
  });

  it("toggles terminal open state per thread", () => {
    const state = makeState(makeThread({ terminalOpen: false }));
    const next = reducer(state, {
      type: "TOGGLE_THREAD_TERMINAL",
      threadId: "thread-local-1",
    });
    expect(next.threads[0]?.terminalOpen).toBe(true);
  });

  it("sets terminal open state per thread", () => {
    const state = makeState(makeThread({ terminalOpen: true }));
    const next = reducer(state, {
      type: "SET_THREAD_TERMINAL_OPEN",
      threadId: "thread-local-1",
      open: false,
    });
    expect(next.threads[0]?.terminalOpen).toBe(false);
  });

  it("sets terminal height per thread", () => {
    const state = makeState(makeThread({ terminalHeight: 280 }));
    const next = reducer(state, {
      type: "SET_THREAD_TERMINAL_HEIGHT",
      threadId: "thread-local-1",
      height: 360,
    });
    expect(next.threads[0]?.terminalHeight).toBe(360);
  });

  it("splits the active terminal into side-by-side mode", () => {
    const state = makeState(makeThread());
    const next = reducer(state, {
      type: "SPLIT_THREAD_TERMINAL",
      threadId: "thread-local-1",
      terminalId: "term-2",
    });

    expect(next.threads[0]?.terminalLayout).toBe("split");
    expect(next.threads[0]?.terminalIds).toEqual([DEFAULT_THREAD_TERMINAL_ID, "term-2"]);
    expect(next.threads[0]?.splitTerminalIds).toEqual([DEFAULT_THREAD_TERMINAL_ID, "term-2"]);
    expect(next.threads[0]?.activeTerminalId).toBe("term-2");
  });

  it("creates a new full-width terminal and switches to tab mode", () => {
    const state = makeState(makeThread());
    const next = reducer(state, {
      type: "NEW_THREAD_TERMINAL",
      threadId: "thread-local-1",
      terminalId: "term-2",
    });

    expect(next.threads[0]?.terminalLayout).toBe("tabs");
    expect(next.threads[0]?.terminalIds).toEqual([DEFAULT_THREAD_TERMINAL_ID, "term-2"]);
    expect(next.threads[0]?.activeTerminalId).toBe("term-2");
    expect(next.threads[0]?.splitTerminalIds).toEqual([]);
  });

  it("switches the active tab terminal", () => {
    const state = makeState(
      makeThread({
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID, "term-2"],
        activeTerminalId: DEFAULT_THREAD_TERMINAL_ID,
        terminalLayout: "tabs",
      }),
    );
    const next = reducer(state, {
      type: "SET_THREAD_ACTIVE_TERMINAL",
      threadId: "thread-local-1",
      terminalId: "term-2",
    });

    expect(next.threads[0]?.activeTerminalId).toBe("term-2");
  });

  it("backfills codexThreadId from routed provider events", () => {
    const state = makeState(makeThread({ codexThreadId: null }));
    const next = reducer(state, {
      type: "APPLY_EVENT",
      event: makeEvent({
        method: "thread/started",
        payload: { thread: { id: "thr_backfilled" } },
      }),
      activeAssistantItemRef: { current: null },
    });

    expect(next.threads[0]?.codexThreadId).toBe("thr_backfilled");
  });

  it("ignores events from a foreign thread within the same session", () => {
    const state = makeState(makeThread({ codexThreadId: "thr_expected" }));
    const next = reducer(state, {
      type: "APPLY_EVENT",
      event: makeEvent({
        method: "turn/started",
        threadId: "thr_unexpected",
        payload: { turn: { id: "turn-1" } },
      }),
      activeAssistantItemRef: { current: null },
    });

    expect(next).toBe(state);
  });

  it("rebases thread identity on thread/started during connect", () => {
    const state = makeState(
      makeThread({
        codexThreadId: "thr_old",
        session: makeSession({
          status: "connecting",
          threadId: "thr_old",
        }),
      }),
    );
    const next = reducer(state, {
      type: "APPLY_EVENT",
      event: makeEvent({
        method: "thread/started",
        threadId: "thr_new",
        payload: { thread: { id: "thr_new" } },
      }),
      activeAssistantItemRef: { current: null },
    });

    expect(next.threads[0]?.codexThreadId).toBe("thr_new");
    expect(next.threads[0]?.session?.threadId).toBe("thr_new");
  });

  it("reconciles project ids by cwd when syncing backend projects", () => {
    const state: AppState = {
      projects: [
        {
          id: "project-old-a",
          name: "A",
          cwd: "/tmp/a",
          model: "gpt-5.3-codex",
          expanded: false,
        },
        {
          id: "project-old-b",
          name: "B",
          cwd: "/tmp/b",
          model: "gpt-5.3-codex",
          expanded: true,
        },
      ],
      threads: [
        makeThread({
          id: "thread-a",
          projectId: "project-old-a",
        }),
        makeThread({
          id: "thread-b",
          projectId: "project-old-b",
        }),
      ],
      activeThreadId: "thread-b",
      runtimeMode: "full-access",
      diffOpen: false,
    };

    const next = reducer(state, {
      type: "SYNC_PROJECTS",
      projects: [
        {
          id: "project-new-a",
          name: "A",
          cwd: "/tmp/a",
          model: "gpt-5.3-codex",
          expanded: true,
        },
      ],
    });

    expect(next.projects).toHaveLength(1);
    expect(next.projects[0]?.id).toBe("project-new-a");
    // Preserve existing project UI preferences by cwd
    expect(next.projects[0]?.expanded).toBe(false);
    expect(next.threads).toHaveLength(1);
    expect(next.threads[0]?.id).toBe("thread-a");
    expect(next.threads[0]?.projectId).toBe("project-new-a");
    expect(next.activeThreadId).toBe("thread-a");
  });

  it("marks the active thread as visited when selected", () => {
    const state = makeState(
      makeThread({
        lastVisitedAt: "2000-01-01T00:00:00.000Z",
      }),
    );

    const next = reducer(state, {
      type: "SET_ACTIVE_THREAD",
      threadId: "thread-local-1",
    });

    expect(next.activeThreadId).toBe("thread-local-1");
    expect(next.threads[0]?.lastVisitedAt).toBeDefined();
    expect(next.threads[0]?.lastVisitedAt).not.toBe("2000-01-01T00:00:00.000Z");
  });

  it("marks completion as seen immediately for the active thread", () => {
    const state = makeState(
      makeThread({
        session: makeSession({
          status: "running",
          activeTurnId: "turn-1",
        }),
        lastVisitedAt: "2026-02-08T10:00:00.000Z",
      }),
    );

    const completedAt = "2026-02-08T10:00:10.000Z";
    const next = reducer(state, {
      type: "APPLY_EVENT",
      event: makeEvent({
        method: "turn/completed",
        turnId: "turn-1",
        createdAt: completedAt,
        payload: { turn: { id: "turn-1", status: "completed" } },
      }),
      activeAssistantItemRef: { current: null },
    });

    expect(next.threads[0]?.latestTurnCompletedAt).toBe(completedAt);
    expect(next.threads[0]?.lastVisitedAt).toBe(completedAt);
  });
});
