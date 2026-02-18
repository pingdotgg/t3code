import type { ProviderEvent, ProviderSession, TerminalEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { type AppState, reducer } from "./store";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_THREAD_TERMINAL_COUNT,
} from "./types";
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
    turnDiffSummaries: [],
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
        scripts: [],
      },
    ],
    threads: [thread],
    activeThreadId: thread.id,
    runtimeMode: "full-access",
    diffOpen: false,
    diffThreadId: null,
    diffTurnId: null,
    diffFilePath: null,
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

  it("opens diff panel with an explicit turn/file target", () => {
    const state = makeState(makeThread());
    const next = reducer(state, {
      type: "OPEN_DIFF",
      threadId: "thread-local-1",
      turnId: "turn-1",
      filePath: "src/app.ts",
    });

    expect(next.diffOpen).toBe(true);
    expect(next.diffThreadId).toBe("thread-local-1");
    expect(next.diffTurnId).toBe("turn-1");
    expect(next.diffFilePath).toBe("src/app.ts");
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

  it("caps split terminals at four per thread", () => {
    const state = makeState(
      makeThread({
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID, "term-2", "term-3", "term-4"],
        activeTerminalId: "term-4",
        terminalGroups: [
          {
            id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
            terminalIds: [DEFAULT_THREAD_TERMINAL_ID, "term-2", "term-3", "term-4"],
          },
        ],
        activeTerminalGroupId: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
      }),
    );
    const next = reducer(state, {
      type: "SPLIT_THREAD_TERMINAL",
      threadId: "thread-local-1",
      terminalId: "term-5",
    });

    expect(next.threads[0]?.terminalIds).toHaveLength(MAX_THREAD_TERMINAL_COUNT);
    expect(next.threads[0]?.terminalIds).toEqual([
      DEFAULT_THREAD_TERMINAL_ID,
      "term-2",
      "term-3",
      "term-4",
    ]);
    expect(next.threads[0]?.activeTerminalId).toBe("term-4");
  });

  it("caps new terminals at four per thread", () => {
    const state = makeState(
      makeThread({
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID, "term-2", "term-3", "term-4"],
        activeTerminalId: "term-4",
        terminalGroups: [
          {
            id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
            terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
          },
          { id: "group-term-2", terminalIds: ["term-2"] },
          { id: "group-term-3", terminalIds: ["term-3"] },
          { id: "group-term-4", terminalIds: ["term-4"] },
        ],
        activeTerminalGroupId: "group-term-4",
      }),
    );
    const next = reducer(state, {
      type: "NEW_THREAD_TERMINAL",
      threadId: "thread-local-1",
      terminalId: "term-5",
    });

    expect(next.threads[0]?.terminalIds).toHaveLength(MAX_THREAD_TERMINAL_COUNT);
    expect(next.threads[0]?.terminalIds).toEqual([
      DEFAULT_THREAD_TERMINAL_ID,
      "term-2",
      "term-3",
      "term-4",
    ]);
    expect(next.threads[0]?.activeTerminalId).toBe("term-4");
    expect(next.threads[0]?.activeTerminalGroupId).toBe("group-term-4");
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

  it("closes the final terminal and hides the drawer", () => {
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

    expect(next.threads[0]?.terminalOpen).toBe(false);
    expect(next.threads[0]?.terminalIds).toEqual([DEFAULT_THREAD_TERMINAL_ID]);
    expect(next.threads[0]?.runningTerminalIds).toEqual([]);
    expect(next.threads[0]?.activeTerminalId).toBe(DEFAULT_THREAD_TERMINAL_ID);
    expect(next.threads[0]?.terminalGroups).toEqual([
      {
        id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
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

  it("preserves persisted turn diffs when events were reset and appends new completed turn diffs", () => {
    const state = makeState(
      makeThread({
        events: [],
        turnDiffSummaries: [
          {
            turnId: "turn-1",
            completedAt: "2026-02-09T00:00:01.000Z",
            files: [{ path: "src/existing.ts", kind: "modified" }],
          },
        ],
      }),
    );

    const withFileChange = reducer(state, {
      type: "APPLY_EVENT",
      event: makeEvent({
        method: "item/completed",
        turnId: "turn-2",
        createdAt: "2026-02-09T00:00:02.000Z",
        payload: {
          item: {
            type: "fileChange",
            changes: [{ path: "src/new.ts", kind: "added" }],
          },
        },
      }),
      activeAssistantItemRef: { current: null },
    });

    expect(withFileChange.threads[0]?.turnDiffSummaries.map((summary) => summary.turnId)).toEqual([
      "turn-1",
    ]);

    const completed = reducer(withFileChange, {
      type: "APPLY_EVENT",
      event: makeEvent({
        method: "turn/completed",
        turnId: "turn-2",
        createdAt: "2026-02-09T00:00:03.000Z",
        payload: { turn: { id: "turn-2", status: "completed" } },
      }),
      activeAssistantItemRef: { current: null },
    });

    expect(completed.threads[0]?.turnDiffSummaries.map((summary) => summary.turnId)).toEqual([
      "turn-2",
      "turn-1",
    ]);
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
          scripts: [],
        },
        {
          id: "project-old-b",
          name: "B",
          cwd: "/tmp/b",
          model: "gpt-5.3-codex",
          expanded: true,
          scripts: [],
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
      diffThreadId: null,
      diffTurnId: null,
      diffFilePath: null,
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
          scripts: [],
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

  it("treats empty scripts from sync as authoritative", () => {
    const state: AppState = {
      projects: [
        {
          id: "project-old-a",
          name: "A",
          cwd: "/tmp/a",
          model: "gpt-5.3-codex",
          expanded: true,
          scripts: [
            {
              id: "test",
              name: "Test",
              command: "bun test",
              icon: "test",
              runOnWorktreeCreate: false,
            },
          ],
        },
      ],
      threads: [makeThread({ id: "thread-a", projectId: "project-old-a" })],
      activeThreadId: "thread-a",
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
          expanded: false,
          scripts: [],
        },
      ],
    });

    expect(next.projects[0]?.scripts).toEqual([]);
  });

  it("updates project scripts", () => {
    const state = makeState(makeThread());
    const next = reducer(state, {
      type: "SET_PROJECT_SCRIPTS",
      projectId: "project-1",
      scripts: [
        {
          id: "test",
          name: "Test",
          command: "bun test",
          icon: "test",
          runOnWorktreeCreate: false,
        },
      ],
    });

    expect(next.projects[0]?.scripts).toEqual([
      {
        id: "test",
        name: "Test",
        command: "bun test",
        icon: "test",
        runOnWorktreeCreate: false,
      },
    ]);
  });

  it("deletes a project and all of its threads", () => {
    const state: AppState = {
      projects: [
        {
          id: "project-1",
          name: "One",
          cwd: "/tmp/one",
          model: "gpt-5.3-codex",
          expanded: true,
          scripts: [],
        },
        {
          id: "project-2",
          name: "Two",
          cwd: "/tmp/two",
          model: "gpt-5.3-codex",
          expanded: true,
          scripts: [],
        },
      ],
      threads: [
        makeThread({
          id: "thread-a",
          projectId: "project-1",
        }),
        makeThread({
          id: "thread-b",
          projectId: "project-2",
        }),
      ],
      activeThreadId: "thread-a",
      runtimeMode: "full-access",
      diffOpen: false,
      diffThreadId: null,
      diffTurnId: null,
      diffFilePath: null,
    };

    const next = reducer(state, {
      type: "DELETE_PROJECT",
      projectId: "project-1",
    });

    expect(next.projects).toHaveLength(1);
    expect(next.projects[0]?.id).toBe("project-2");
    expect(next.threads).toHaveLength(1);
    expect(next.threads[0]?.id).toBe("thread-b");
    expect(next.activeThreadId).toBe("thread-b");
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

  it("reverts thread state to a checkpoint snapshot", () => {
    const state = makeState(
      makeThread({
        codexThreadId: "thr_before",
        session: makeSession({
          status: "running",
          threadId: "thr_before",
          activeTurnId: "turn-live",
        }),
        messages: [
          {
            id: "m-1",
            role: "user",
            text: "First",
            createdAt: "2026-02-08T10:00:00.000Z",
            streaming: false,
          },
          {
            id: "m-2",
            role: "assistant",
            text: "First reply",
            createdAt: "2026-02-08T10:00:01.000Z",
            streaming: false,
          },
          {
            id: "m-3",
            role: "user",
            text: "Second",
            createdAt: "2026-02-08T10:00:02.000Z",
            streaming: false,
          },
        ],
        events: [
          makeEvent({
            method: "turn/started",
            turnId: "turn-live",
          }),
        ],
        turnDiffSummaries: [
          {
            turnId: "turn_1",
            completedAt: "2026-02-08T10:00:01.000Z",
            files: [{ path: "src/first.ts", kind: "modified" }],
            checkpointTurnCount: 1,
          },
          {
            turnId: "turn_2",
            completedAt: "2026-02-08T10:00:03.000Z",
            files: [{ path: "src/second.ts", kind: "modified" }],
            checkpointTurnCount: 2,
          },
        ],
        error: "temporary failure",
        latestTurnId: "turn-live",
        latestTurnStartedAt: "2026-02-08T10:00:03.000Z",
      }),
    );

    const next = reducer(state, {
      type: "REVERT_TO_CHECKPOINT",
      threadId: "thread-local-1",
      sessionId: "sess-1",
      threadRuntimeId: "thr_after",
      turnCount: 1,
      messageCount: 2,
    });

    expect(next.threads[0]?.codexThreadId).toBe("thr_after");
    expect(next.threads[0]?.messages.map((message) => message.id)).toEqual(["m-1", "m-2"]);
    expect(next.threads[0]?.events).toEqual([]);
    expect(next.threads[0]?.error).toBeNull();
    expect(next.threads[0]?.session?.status).toBe("ready");
    expect(next.threads[0]?.session?.activeTurnId).toBeUndefined();
    expect(next.threads[0]?.session?.threadId).toBe("thr_after");
    expect(next.threads[0]?.latestTurnId).toBeUndefined();
    expect(next.threads[0]?.turnDiffSummaries.map((summary) => summary.turnId)).toEqual(["turn_1"]);
  });

  it("keeps checkpoint-derived turn files when later events for the same turn arrive", () => {
    const state = makeState(
      makeThread({
        turnDiffSummaries: [
          {
            turnId: "turn-1",
            completedAt: "2026-02-09T00:00:03.000Z",
            files: [{ path: "src/from-checkpoint.ts", diff: "diff --git a/src/from-checkpoint.ts b/src/from-checkpoint.ts" }],
            unifiedDiff: "diff --git a/src/from-checkpoint.ts b/src/from-checkpoint.ts",
            checkpointDiffLoaded: true,
          },
        ],
      }),
    );

    const next = reducer(state, {
      type: "APPLY_EVENT",
      event: makeEvent({
        method: "turn/completed",
        turnId: "turn-1",
        createdAt: "2026-02-09T00:00:04.000Z",
        payload: { turn: { id: "turn-1", status: "completed" } },
      }),
      activeAssistantItemRef: { current: null },
    });

    expect(next.threads[0]?.turnDiffSummaries[0]?.files.map((file) => file.path)).toEqual([
      "src/from-checkpoint.ts",
    ]);
    expect(next.threads[0]?.turnDiffSummaries[0]?.checkpointDiffLoaded).toBe(true);
    expect(next.threads[0]?.turnDiffSummaries[0]?.unifiedDiff).toContain("from-checkpoint.ts");
  });

  it("updates turn summaries from checkpoint diffs and marks them as loaded", () => {
    const state = makeState(
      makeThread({
        turnDiffSummaries: [
          {
            turnId: "turn-1",
            completedAt: "2026-02-09T00:00:03.000Z",
            files: [],
            checkpointTurnCount: 1,
          },
        ],
      }),
    );

    const next = reducer(state, {
      type: "SET_THREAD_TURN_CHECKPOINT_DIFFS",
      threadId: "thread-local-1",
      checkpointDiffByTurnId: {
        "turn-1": [
          "diff --git a/src/a.ts b/src/a.ts",
          "@@ -1 +1 @@",
          "-old-a",
          "+new-a",
          "diff --git a/src/b.ts b/src/b.ts",
          "@@ -1 +1 @@",
          "-old-b",
          "+new-b",
        ].join("\n"),
      },
    });

    expect(next.threads[0]?.turnDiffSummaries[0]?.files.map((file) => file.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(next.threads[0]?.turnDiffSummaries[0]?.checkpointDiffLoaded).toBe(true);
  });
});
