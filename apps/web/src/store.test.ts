import type { ProviderEvent, ProviderSession, TerminalEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { type AppState, reducer } from "./store";
import { DEFAULT_THREAD_TERMINAL_HEIGHT, DEFAULT_THREAD_TERMINAL_ID } from "./types";
import type { Thread } from "./types";

type TerminalStartedEvent = Extract<TerminalEvent, { type: "started" }>;
type TerminalActivityEvent = Extract<TerminalEvent, { type: "activity" }>;

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
    runningTerminalIds: [],
    activeTerminalId: DEFAULT_THREAD_TERMINAL_ID,
    terminalGroups: [
      {
        id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
      },
    ],
    activeTerminalGroupId: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
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

function makeTerminalStartedEvent(
  overrides: Partial<TerminalStartedEvent> = {},
): TerminalStartedEvent {
  return {
    type: "started",
    threadId: "thread-local-1",
    terminalId: DEFAULT_THREAD_TERMINAL_ID,
    createdAt: "2026-02-09T00:00:01.000Z",
    snapshot: {
      threadId: "thread-local-1",
      terminalId: DEFAULT_THREAD_TERMINAL_ID,
      cwd: "/tmp/project",
      status: "running",
      pid: 1234,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-02-09T00:00:01.000Z",
    },
    ...overrides,
  };
}

function makeTerminalActivityEvent(
  overrides: Partial<TerminalActivityEvent> = {},
): TerminalActivityEvent {
  return {
    type: "activity",
    threadId: "thread-local-1",
    terminalId: DEFAULT_THREAD_TERMINAL_ID,
    createdAt: "2026-02-09T00:00:02.000Z",
    hasRunningSubprocess: true,
    ...overrides,
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

    expect(next.threads[0]?.terminalIds).toEqual([DEFAULT_THREAD_TERMINAL_ID, "term-2"]);
    expect(next.threads[0]?.activeTerminalId).toBe("term-2");
    expect(next.threads[0]?.terminalGroups).toEqual([
      {
        id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID, "term-2"],
      },
    ]);
    expect(next.threads[0]?.activeTerminalGroupId).toBe(`group-${DEFAULT_THREAD_TERMINAL_ID}`);
  });

  it("creates a new full-width terminal and switches to tab mode", () => {
    const state = makeState(makeThread());
    const next = reducer(state, {
      type: "NEW_THREAD_TERMINAL",
      threadId: "thread-local-1",
      terminalId: "term-2",
    });

    expect(next.threads[0]?.terminalIds).toEqual([DEFAULT_THREAD_TERMINAL_ID, "term-2"]);
    expect(next.threads[0]?.activeTerminalId).toBe("term-2");
    expect(next.threads[0]?.terminalGroups).toEqual([
      {
        id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
      },
      { id: "group-term-2", terminalIds: ["term-2"] },
    ]);
    expect(next.threads[0]?.activeTerminalGroupId).toBe("group-term-2");
  });

  it("switches the active terminal and restores its owning group", () => {
    const state = makeState(
      makeThread({
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID, "term-2", "term-3"],
        activeTerminalId: DEFAULT_THREAD_TERMINAL_ID,
        terminalGroups: [
          {
            id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
            terminalIds: [DEFAULT_THREAD_TERMINAL_ID, "term-2"],
          },
          { id: "group-term-3", terminalIds: ["term-3"] },
        ],
        activeTerminalGroupId: "group-term-3",
      }),
    );
    const next = reducer(state, {
      type: "SET_THREAD_ACTIVE_TERMINAL",
      threadId: "thread-local-1",
      terminalId: "term-2",
    });

    expect(next.threads[0]?.activeTerminalId).toBe("term-2");
    expect(next.threads[0]?.activeTerminalGroupId).toBe(`group-${DEFAULT_THREAD_TERMINAL_ID}`);
  });

  it("supports splitting beyond two terminals in the same group", () => {
    const state = makeState(
      makeThread({
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID, "term-2"],
        activeTerminalId: "term-2",
        terminalGroups: [
          {
            id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
            terminalIds: [DEFAULT_THREAD_TERMINAL_ID, "term-2"],
          },
        ],
        activeTerminalGroupId: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
      }),
    );
    const next = reducer(state, {
      type: "SPLIT_THREAD_TERMINAL",
      threadId: "thread-local-1",
      terminalId: "term-3",
    });

    expect(next.threads[0]?.terminalIds).toEqual([DEFAULT_THREAD_TERMINAL_ID, "term-2", "term-3"]);
    expect(next.threads[0]?.terminalGroups).toEqual([
      {
        id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID, "term-2", "term-3"],
      },
    ]);
    expect(next.threads[0]?.activeTerminalId).toBe("term-3");
    expect(next.threads[0]?.activeTerminalGroupId).toBe(`group-${DEFAULT_THREAD_TERMINAL_ID}`);
  });

  it("closes a terminal and keeps grouped layout coherent", () => {
    const state = makeState(
      makeThread({
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID, "term-2", "term-3"],
        activeTerminalId: "term-2",
        terminalGroups: [
          {
            id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
            terminalIds: [DEFAULT_THREAD_TERMINAL_ID, "term-2"],
          },
          { id: "group-term-3", terminalIds: ["term-3"] },
        ],
        activeTerminalGroupId: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
      }),
    );
    const next = reducer(state, {
      type: "CLOSE_THREAD_TERMINAL",
      threadId: "thread-local-1",
      terminalId: "term-2",
    });

    expect(next.threads[0]?.terminalIds).toEqual([DEFAULT_THREAD_TERMINAL_ID, "term-3"]);
    expect(next.threads[0]?.activeTerminalId).toBe(DEFAULT_THREAD_TERMINAL_ID);
    expect(next.threads[0]?.terminalGroups).toEqual([
      {
        id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
      },
      { id: "group-term-3", terminalIds: ["term-3"] },
    ]);
  });

  it("closes the final terminal and keeps the drawer visibility unchanged", () => {
    const state = makeState(
      makeThread({
        terminalOpen: true,
        runningTerminalIds: [DEFAULT_THREAD_TERMINAL_ID],
      }),
    );
    const next = reducer(state, {
      type: "CLOSE_THREAD_TERMINAL",
      threadId: "thread-local-1",
      terminalId: DEFAULT_THREAD_TERMINAL_ID,
    });

    expect(next.threads[0]?.terminalOpen).toBe(true);
    expect(next.threads[0]?.terminalIds).toEqual([`${DEFAULT_THREAD_TERMINAL_ID}-next`]);
    expect(next.threads[0]?.runningTerminalIds).toEqual([]);
    expect(next.threads[0]?.activeTerminalId).toBe(`${DEFAULT_THREAD_TERMINAL_ID}-next`);
    expect(next.threads[0]?.terminalGroups).toEqual([
      {
        id: `group-${DEFAULT_THREAD_TERMINAL_ID}-next`,
        terminalIds: [`${DEFAULT_THREAD_TERMINAL_ID}-next`],
      },
    ]);
  });

  it("tracks running terminals from subprocess activity events", () => {
    const state = makeState(makeThread());
    const started = reducer(state, {
      type: "APPLY_TERMINAL_EVENT",
      event: makeTerminalStartedEvent(),
    });
    expect(started.threads[0]?.runningTerminalIds).toEqual([]);

    const active = reducer(started, {
      type: "APPLY_TERMINAL_EVENT",
      event: makeTerminalActivityEvent(),
    });
    expect(active.threads[0]?.runningTerminalIds).toEqual([DEFAULT_THREAD_TERMINAL_ID]);

    const idle = reducer(active, {
      type: "APPLY_TERMINAL_EVENT",
      event: makeTerminalActivityEvent({ hasRunningSubprocess: false }),
    });
    expect(idle.threads[0]?.runningTerminalIds).toEqual([]);

    const exited = reducer(active, {
      type: "APPLY_TERMINAL_EVENT",
      event: {
        type: "exited",
        threadId: "thread-local-1",
        terminalId: DEFAULT_THREAD_TERMINAL_ID,
        createdAt: "2026-02-09T00:00:05.000Z",
        exitCode: 0,
        exitSignal: null,
      },
    });
    expect(exited.threads[0]?.runningTerminalIds).toEqual([]);
  });

  it("keeps running status when another terminal in the thread is still running", () => {
    const state = makeState(
      makeThread({
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID, "term-2"],
        runningTerminalIds: [DEFAULT_THREAD_TERMINAL_ID, "term-2"],
        activeTerminalId: "term-2",
        terminalGroups: [
          {
            id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
            terminalIds: [DEFAULT_THREAD_TERMINAL_ID, "term-2"],
          },
        ],
        activeTerminalGroupId: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
      }),
    );

    const next = reducer(state, {
      type: "APPLY_TERMINAL_EVENT",
      event: {
        type: "exited",
        threadId: "thread-local-1",
        terminalId: DEFAULT_THREAD_TERMINAL_ID,
        createdAt: "2026-02-09T00:00:07.000Z",
        exitCode: 0,
        exitSignal: null,
      },
    });

    expect(next.threads[0]?.runningTerminalIds).toEqual(["term-2"]);
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
